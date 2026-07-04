import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import { addMs } from '../clock.js'
import type { SourcesRepo } from '../db/repos/sources.js'
import type { ProcessingJobsRepo } from '../db/repos/jobs.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { ConflictsRepo } from '../db/repos/conflicts.js'
import type { CollectionItemsRepo } from '../db/repos/collectionItems.js'
import type { DraftsRepo } from '../db/repos/drafts.js'
import type { LeaseClaimer } from '../lease/leaseClaimer.js'
import type { LlmClient } from '../extraction/llmClient.js'
import type { FormType } from '../schema/profile.js'
import { extractFacts } from '../extraction/extractor.js'
import { reconcile } from '../profile/reconciler.js'
import { renderForm } from '../forms/renderers.js'

export interface ProcessorDeps {
  db: DB; sources: SourcesRepo; jobs: ProcessingJobsRepo; facts: FactsRepo; conflicts: ConflictsRepo
  items: CollectionItemsRepo; drafts: DraftsRepo; lease: LeaseClaimer; llm: LlmClient
  clock: Clock; workerId: string; formTypes: FormType[]; leaseMs?: number; batch?: number; maxAttempts?: number
}

interface SourcePayload { content: string }

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

/**
 * Ordering per job (AGENTS.md #12): claim (fenced, via `LeaseClaimer` on `processing_jobs`) ->
 * `llm.extract` OUTSIDE any transaction (the only async/network work in this worker) -> ONE
 * transaction that atomically {registers collection items, inserts facts, reconciles/detects
 * conflicts, re-projects every form draft + its bindings, and fence-completes the job}. If the
 * fenced `complete()` returns false (lease lost to another worker), we throw to roll the WHOLE
 * transaction back — nothing above it persists — and the row is left processing until its lease
 * expires and it is reclaimed and redone cleanly.
 *
 * Deviation from the brief's literal reference code (documented per task instructions, watching
 * for "domain writes committing before/independently of the fence"): the reference `drainOnce`
 * called `extractFacts(env, ctx)` BETWEEN the `await llm.extract(...)` and the opening of the
 * persist transaction. `extractFacts` is synchronous, but for repeated-collection fields (e.g.
 * `claims`) it calls `resolveItemId`, which — on a natural key not yet seen — performs a real
 * SQLite write via `CollectionItemsRepo.insert` (AGENTS.md #12 explicitly lists "collection item
 * registry writes" as one of the things that must commit atomically with facts/reconciliation/
 * projection/fenced-completion). Running `extractFacts` outside the transaction meant that write
 * auto-committed immediately, independent of whether the fence later succeeded — so a lost lease
 * would roll back facts/drafts/job-completion but leave a NEW collection_items row behind,
 * silently violating the all-or-nothing invariant. Proof of the bug (revert-and-fail): moving
 * `extractFacts` back out to its original position and re-running
 * `tests/worker/processor.test.ts` "persistence + job completion are atomic ..." fails on
 * `expect(new CollectionItemsRepo(db).findId('c1','claims','2023|workers_comp')).toBeUndefined()`
 * — the row exists despite the fence returning false. The fix moves `extractFacts` inside
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

        // The LLM call is the ONLY async/network work, and it runs OUTSIDE any transaction.
        const env = await this.d.llm.extract(transcript)

        const persistAndComplete = this.d.db.transaction(() => {
          // extractFacts registers new collection items (a DB write via resolveItemId) as a
          // side effect — it must run INSIDE this transaction, not before it, so that write
          // rolls back along with everything else if the fence below fails.
          const facts = extractFacts(env, {
            customerId: job.customer_id, sourceId: source.id, sourceDate: source.source_date,
            transcript, clock: this.d.clock, itemsRepo: this.d.items,
          })
          this.d.facts.insertMany(facts)
          reconcile({
            db: this.d.db, facts: this.d.facts, conflicts: this.d.conflicts, clock: this.d.clock,
            customerId: job.customer_id, formTypes: this.d.formTypes,
          })
          const currentFacts = this.d.facts.currentMap(job.customer_id)
          for (const ft of this.d.formTypes) {
            const { mapping, fieldBindings } = renderForm(ft, currentFacts)
            const draft = this.d.drafts.upsertProjection(job.customer_id, ft, mapping, this.d.clock.now())
            this.d.drafts.saveBindings(draft.id, fieldBindings)
          }
          // Fenced: false if we lost the lease. Throw to roll the whole transaction back so
          // another worker's run is the single source of truth — never double-applied.
          if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
        })
        // On commit failure (lost lease OR a real persistence error) back off. fail() is
        // fenced, so a lost-lease rollback is a harmless no-op; a real error gets retried.
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
