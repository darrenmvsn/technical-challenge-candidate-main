import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import { addMs } from '../clock.js'
import type { OutboxRepo } from '../db/repos/outbox.js'
import type { DraftsRepo } from '../db/repos/drafts.js'
import type { LeaseClaimer } from '../lease/leaseClaimer.js'
import type { BlobStore } from '../blob/blobStore.js'
import type { FormType } from '../schema/profile.js'
import type { FillMapping } from '../schema/forms.js'
import { fillForm } from '../forms/fillForm.js'

export interface OutboxWorkerDeps {
  db: DB; outbox: OutboxRepo; drafts: DraftsRepo; blob: BlobStore; lease: LeaseClaimer
  clock: Clock; workerId: string; leaseMs?: number; batch?: number; maxAttempts?: number
}

/** Backoff schedule indexed by attempt count so far (capped at the last entry). */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

/**
 * Durable "fill exactly once" enforcer (AGENTS.md #5/#8/#9/#12).
 *
 * Ordering per row: claim (fenced, via LeaseClaimer on `outbox`) -> fillForm OUTSIDE any DB
 * transaction (it is the only network/blob I/O in this worker) -> ONE transaction that
 * atomically marks {outbox=done, draft=filled}, fenced by the SAME lock token the claim
 * returned. If the fenced completion loses the race (stale/lost lease), the whole commit
 * throws and rolls back — the fill is NOT recorded as done, and the row is left claimable
 * again via fail()'s backoff. Because fillForm is content-addressed (same customerId +
 * formType + mapping -> same blob key), a retry after a lost-lease rollback re-derives the
 * identical key: the row transitions to done/filled exactly once even though fillForm may
 * run more than once across retries.
 */
export class OutboxWorker {
  constructor(private d: OutboxWorkerDeps) {}

  async drainOnce(): Promise<number> {
    const now = this.d.clock.now()
    const claimed = this.d.lease.claim(now, this.d.leaseMs ?? 30_000, this.d.workerId, this.d.batch ?? 10)
    let filled = 0
    for (const { id, lock_token } of claimed) {
      const row = this.d.outbox.get(id)
      if (!row || row.status !== 'processing') continue
      try {
        // payload_json is the NESTED fill mapping (README fill_form shape), enqueued at approve time.
        const mapping = JSON.parse(row.payload_json) as FillMapping
        // External I/O (PDF generation) happens OUTSIDE any DB transaction — AGENTS.md #5/#12.
        const { pdf_ref } = await fillForm(row.customer_id, row.form_type as FormType, mapping, this.d.blob)
        // Commit `outbox=done` AND `draft=filled` atomically. If the process dies between
        // them, neither lands: the row is still 'processing', its lease expires, and it is
        // re-fetched — never stranded as a done outbox row over an unfilled draft.
        // `complete()` is fenced (id+token+status='processing'); if we lost the lease it
        // returns false and we throw to roll the whole transaction back (no markFilled).
        const commit = this.d.db.transaction(() => {
          if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
          const draft = this.d.drafts.current(row.customer_id, row.form_type as FormType)
          if (draft && draft.revision === row.draft_revision) this.d.drafts.markFilled(draft.id, pdf_ref, this.d.clock.now())
        })
        try {
          commit(); filled++
        } catch {
          // Rolled back (lost lease, or a local write failed). fail() is fenced: a no-op if
          // we no longer hold the lease, otherwise it applies backoff + dead-letters at max.
          // fillForm is idempotent (content-addressed), so a retry is safe.
          this.fail(id, lock_token, row.attempts, now)
        }
      } catch {
        this.fail(id, lock_token, row.attempts, now)
      }
    }
    return filled
  }

  private fail(id: string, lockToken: string, attempts: number, now: string): void {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!
    const next = addMs(now, backoff) // AGENTS.md #3: date arithmetic via the clock.ts helper, never inline `new Date(...)`
    this.d.lease.fail(id, lockToken, next, this.d.maxAttempts ?? 5)
  }
}
