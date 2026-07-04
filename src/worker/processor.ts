import type { DB } from '../db/sqlite'
import type { Clock } from '../clock'
import { addMs } from '../clock'
import type { SourcesRepo } from '../db/repos/sources'
import type { ProcessingJobsRepo } from '../db/repos/jobs'
import type { ExtractedFieldCandidatesRepo } from '../db/repos/extractedFieldCandidates'
import type { FieldReviewVersionsRepo } from '../db/repos/fieldReviewVersions'
import type { FieldConflictsRepo } from '../db/repos/fieldConflicts'
import type { CollectionItemsRepo } from '../db/repos/collectionItems'
import type { DraftsRepo } from '../db/repos/drafts'
import type { OutboxRepo } from '../db/repos/outbox'
import type { LeaseClaimer } from '../lease/leaseClaimer'
import type { LlmClient } from '../extraction/llmClient'
import type { FormType } from '../schema/profile'
import { ExtractionEnvelope } from '../schema/profile'
import { CustomerResolver } from '../identity/customerResolver'
import { extractFacts } from '../extraction/extractor'
import { reconcile } from '../profile/reconciler'
import { renderForm } from '../forms/renderers'
import { currentProfileMap } from '../profile/currentProfile'

export interface ProcessorDeps {
  db: DB; sources: SourcesRepo; jobs: ProcessingJobsRepo; candidates: ExtractedFieldCandidatesRepo
  reviewVersions: FieldReviewVersionsRepo; conflicts: FieldConflictsRepo
  items: CollectionItemsRepo; drafts: DraftsRepo; outbox: OutboxRepo; lease: LeaseClaimer; llm: LlmClient
  resolver: CustomerResolver
  clock: Clock; workerId: string; formTypes: FormType[]; leaseMs?: number; batch?: number; maxAttempts?: number
}

interface SourcePayload { content: string }

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

/**
 * Ordering per job (AGENTS.md #12): claim (fenced, via `LeaseClaimer` on `processing_jobs`) ->
 * `llm.extract` OUTSIDE any transaction (the only async/network work in this worker) -> ONE
 * transaction that atomically {stores the extraction, resolves the customer identity, registers
 * collection items, inserts candidates, reconciles/detects conflicts, re-projects every form draft +
 * its bindings, and fence-completes the job}. Identity resolution (`CustomerResolver.resolve`)
 * runs INSIDE this transaction — it performs its own DB writes (customer + identity signals +
 * resolution row), and better-sqlite3 nests them via SAVEPOINTs, so they are atomic with the
 * candidate/draft writes: a customer is never created without its candidates, and vice versa. If the
 * fenced `complete()` returns false (lease lost to another worker), we throw to roll the WHOLE
 * transaction back — nothing above it persists — and the row is left processing until its lease
 * expires and it is reclaimed and redone cleanly.
 *
 * Identity is resolved from the transcript, not carried on the job: a source ingested BEFORE its
 * customer is known (`customer_id` null) is resolved here. An ambiguous/absent hard identity
 * signal parks the source at `identity_needs_review` and completes the job WITHOUT writing any
 * customer-scoped candidates. A source whose `customer_id` was already set (the manual identity-review
 * attach path, Task 6) skips the automatic resolver and persists under the reviewer's choice. A
 * stored `extraction_json` is reused (re-validated, no second LLM call) so a requeue after review
 * — or any retry — is cheap and side-effect-free.
 *
 * Deviation from the brief's literal reference code (documented per task instructions, watching
 * for "domain writes committing before/independently of the fence"): the reference `drainOnce`
 * called `extractFacts(env, ctx)` BETWEEN the `await llm.extract(...)` and the opening of the
 * persist transaction. `extractFacts` is synchronous, but for repeated-collection fields (e.g.
 * `claims`) it calls `resolveItemId`, which — on a natural key not yet seen — performs a real
 * SQLite write via `CollectionItemsRepo.insert` (AGENTS.md #12 explicitly lists "collection item
 * registry writes" as one of the things that must commit atomically with candidates/reconciliation/
 * projection/fenced-completion). Running `extractFacts` outside the transaction meant that write
 * auto-committed immediately, independent of whether the fence later succeeded — so a lost lease
 * would roll back candidates/drafts/job-completion but leave a NEW collection_items row behind,
 * silently violating the all-or-nothing invariant. The fix keeps `extractFacts` inside
 * `persistAndComplete`, after the LLM call: the ONLY thing left outside the transaction is the
 * `await this.d.llm.extract(...)` call itself. Also fixed inline `new Date(...)` backoff math to
 * use the `addMs` clock helper (AGENTS.md #3 — date arithmetic must live in `clock.ts`, not
 * inline worker code); the reference code computed backoff with `new Date(new
 * Date(now).getTime() + backoff).toISOString()` directly in `fail()`.
 */
export class Processor {
  constructor(private d: ProcessorDeps) {}

  async drainOnce(): Promise<number> {
    const now = this.d.clock.now()
    const claimed = this.d.lease.claim(now, this.d.leaseMs ?? 60_000, this.d.workerId, this.d.batch ?? 5)
    let done = 0
    for (const { id, lock_token } of claimed) {
      const job = this.d.jobs.get(id)
      if (!job || job.status !== 'processing') continue
      try {
        const source = this.d.sources.get(job.source_id)
        if (!source) { this.d.lease.complete(id, lock_token); continue }
        const { content: transcript } = JSON.parse(source.raw_json) as SourcePayload

        // Reuse a stored extraction (manual identity-review requeue) — NO second LLM call.
        // Otherwise extract now; the LLM call is the ONLY async/network work, OUTSIDE any transaction.
        const env = source.extraction_json != null
          ? ExtractionEnvelope.parse(JSON.parse(source.extraction_json))
          : await this.d.llm.extract(transcript)

        const persistAndComplete = this.d.db.transaction(() => {
          // Store extraction so any retry/requeue reuses it instead of re-calling the LLM.
          this.d.sources.saveExtraction(source.id, JSON.stringify(env))

          // Resolve identity BEFORE any customer-scoped write.
          let customerId: string
          if (source.customer_id != null) {
            // Manual identity-review attach path: reviewer already chose the customer.
            customerId = source.customer_id
            this.d.sources.attachCustomer(source.id, customerId, this.d.clock.now())
          } else {
            const res = this.d.resolver.resolve(env, { sourceId: source.id, now: this.d.clock.now(), transcript })
            if (res.status === 'needs_review') {
              this.d.sources.markIdentityNeedsReview(source.id)
              if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
              return
            }
            customerId = res.customerId
            this.d.sources.attachCustomer(source.id, customerId, this.d.clock.now())
          }

          // extractFacts registers new collection items (a DB write via resolveItemId) — must run
          // INSIDE this transaction so it rolls back with everything else if the fence fails.
          const candidates = extractFacts(env, {
            customerId, sourceId: source.id, sourceDate: source.source_date,
            transcript, clock: this.d.clock, itemsRepo: this.d.items,
          })
          this.d.candidates.insertMany(candidates)
          reconcile({
            db: this.d.db, candidates: this.d.candidates, reviews: this.d.reviewVersions, conflicts: this.d.conflicts,
            clock: this.d.clock, customerId, formTypes: this.d.formTypes,
          })
          const currentProfile = currentProfileMap(this.d.candidates, this.d.reviewVersions, customerId)
          for (const ft of this.d.formTypes) {
            const { mapping, fieldBindings } = renderForm(ft, currentProfile)
            const before = this.d.drafts.current(customerId, ft)
            const draft = this.d.drafts.upsertProjection(customerId, ft, mapping, this.d.clock.now())
            this.d.drafts.saveBindings(draft.id, fieldBindings)
            if (before && before.id === draft.id && before.projected_json !== draft.projected_json) {
              const pending = this.d.outbox.pendingForForm(customerId, ft)
              if (pending) this.d.outbox.cancel(pending.id)
            }
          }
          if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
        })
        try { persistAndComplete(); done++ } catch { this.fail(id, lock_token, job.attempts, now) }
      } catch {
        this.fail(id, lock_token, job.attempts, now)
      }
    }
    return done
  }

  private fail(id: string, lockToken: string, attempts: number, now: string): void {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!
    const next = addMs(now, backoff) // AGENTS.md #3: date arithmetic via the clock.ts helper, never inline `new Date(...)`
    this.d.lease.fail(id, lockToken, next, this.d.maxAttempts ?? 5)
  }
}
