import type { DB } from '../db/sqlite.js'
import { newLockToken } from '../util/id.js'
import { addMs } from '../clock.js'

/**
 * Closed internal allowlist of tables `LeaseClaimer` is permitted to operate on
 * (AGENTS.md invariant #8). Both tables share the lease-column shape
 * (status, attempts, next_attempt_at, locked_until, lock_token, locked_by).
 * This list is NEVER derived from request/user input — callers pass a literal
 * from this set, and the constructor re-validates at runtime as defense in depth.
 */
const LEASE_TABLES = ['processing_jobs', 'outbox'] as const
export type LeaseTable = (typeof LEASE_TABLES)[number]

interface ClaimedRow {
  id: string
  lock_token: string
}

/**
 * Generic lease-claim primitive over any table matching the lease-column shape.
 * Fencing guarantees (AGENTS.md invariant #8):
 *  - `claim()` runs its SELECT + per-row UPDATE inside a `BEGIN IMMEDIATE` transaction,
 *    taking SQLite's write lock up front so concurrent claimers (separate connections)
 *    serialize rather than racing on the same read snapshot.
 *  - Each UPDATE re-checks the claimable predicate (`status='pending'` OR an expired
 *    processing lease, AND due `next_attempt_at`) in its own `WHERE` clause — a guarded
 *    update. Even a connection that lost the `BEGIN IMMEDIATE` race gets `changes === 0`
 *    on any row another connection already claimed, and only claimed rows are returned.
 *  - `complete()`/`fail()` are token-fenced: `WHERE id=? AND lock_token=? AND
 *    status='processing'`. A stale or wrong token, or a row no longer `processing`
 *    (e.g. cancelled), yields 0 affected rows — surfaced explicitly as `false`
 *    ("lease lost"), never a silent success.
 */
export class LeaseClaimer {
  private readonly table: LeaseTable

  constructor(private db: DB, table: LeaseTable) {
    if (!LEASE_TABLES.includes(table)) {
      throw new Error(`LeaseClaimer: table "${String(table)}" is not in the lease-table allowlist`)
    }
    this.table = table
  }

  /**
   * Atomically lease up to `limit` rows that are pending, or whose processing lease has
   * expired, and are due (`next_attempt_at <= now`). Stamps a fresh `lock_token` and
   * `locked_until` (computed via the `addMs` clock helper, never inline `Date` math) on
   * every row that wins its guarded UPDATE.
   */
  claim(now: string, leaseMs: number, workerId: string, limit: number): ClaimedRow[] {
    const lockedUntil = addMs(now, leaseMs)
    const tx = this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM ${this.table}
           WHERE (status = 'pending' OR (status = 'processing' AND locked_until < @now))
             AND next_attempt_at <= @now
           ORDER BY next_attempt_at ASC
           LIMIT @limit`
        )
        .all({ now, limit }) as { id: string }[]

      const update = this.db.prepare(
        `UPDATE ${this.table}
         SET status = 'processing', locked_until = @lockedUntil, lock_token = @token, locked_by = @workerId
         WHERE id = @id
           AND (status = 'pending' OR (status = 'processing' AND locked_until < @now))
           AND next_attempt_at <= @now`
      )

      const won: ClaimedRow[] = []
      for (const candidate of candidates) {
        const token = newLockToken()
        const info = update.run({ id: candidate.id, now, lockedUntil, token, workerId })
        if (info.changes === 1) won.push({ id: candidate.id, lock_token: token })
      }
      return won
    })
    return tx.immediate()
  }

  /**
   * Mark a leased row done. Fenced by id + lock_token + status='processing'. Returns
   * `false` (not an exception, not a silent no-op) when the fence matches 0 rows —
   * callers must treat that as lease loss and react explicitly (e.g. skip persisting
   * results, log, retry claim).
   */
  complete(id: string, lockToken: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE ${this.table}
         SET status = 'done', locked_until = NULL, lock_token = NULL
         WHERE id = ? AND lock_token = ? AND status = 'processing'`
      )
      .run(id, lockToken)
    return info.changes === 1
  }

  /**
   * Record a failed attempt: token-fenced read of the current attempt count, then bump
   * attempts and either dead-letter (attempts+1 >= maxAttempts) or re-queue as pending
   * with the given backoff `nextAttemptAt`. Returns `false` (lease already lost) when
   * the fenced read finds no matching row — the row is left untouched in that case.
   */
  fail(id: string, lockToken: string, nextAttemptAt: string, maxAttempts: number): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT attempts FROM ${this.table} WHERE id = ? AND lock_token = ? AND status = 'processing'`)
        .get(id, lockToken) as { attempts: number } | undefined
      if (!row) return false

      const attempts = row.attempts + 1
      const status = attempts >= maxAttempts ? 'dead' : 'pending'
      this.db
        .prepare(
          `UPDATE ${this.table}
           SET status = @status, attempts = @attempts, next_attempt_at = @next,
               locked_until = NULL, lock_token = NULL
           WHERE id = @id AND lock_token = @lockToken AND status = 'processing'`
        )
        .run({ id, lockToken, status, attempts, next: nextAttemptAt })
      return true
    })
    return tx()
  }
}
