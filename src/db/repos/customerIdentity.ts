import type { DB } from '../sqlite.js'
import { newId } from '../../util/id.js'
import type { IdentitySignal, IdentitySignalStrength, IdentitySignalType } from '../../identity/identitySignals.js'

/** Thrown when a HARD signal (fein/email) already belongs to a different customer. */
export class IdentitySignalConflictError extends Error {
  constructor(
    public readonly signalType: IdentitySignalType,
    public readonly signalValue: string,
    public readonly existingCustomerId: string,
  ) {
    super(`hard identity signal already belongs to ${existingCustomerId}`)
  }
}

/** fein/email auto-resolve/auto-create; everything else is supporting-only evidence. */
function inferStrength(type: IdentitySignalType): IdentitySignalStrength {
  return type === 'fein' || type === 'email' ? 'hard' : 'supporting'
}

export class CustomerIdentityRepo {
  constructor(private db: DB) {}

  /**
   * Run a group of writes atomically (AGENTS.md invariant #5). better-sqlite3 nests transactions
   * via SAVEPOINTs, so this is safe to call from inside an outer transaction — e.g. the processor
   * (Task 5) resolves identity inside its all-or-nothing persistence transaction (invariant #12).
   * On a thrown error the inner savepoint rolls back to its start and the error re-propagates,
   * leaving the outer transaction intact for the caller to handle.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  createCustomer(args: { legalName: string | null; dba: string | null; owner: string | null; now: string }): string {
    const id = newId()
    this.db.prepare('INSERT INTO customers (id, name, dba, owner) VALUES (?,?,?,?)')
      .run(id, args.legalName, args.dba, args.owner)
    return id
  }

  customerExists(customerId: string): boolean {
    return this.db.prepare('SELECT 1 FROM customers WHERE id=?').get(customerId) !== undefined
  }

  /**
   * Idempotent per (customer_id, signal_type, signal_value): a retried source re-inserting the
   * same signal for the same customer is a silent no-op. A hard signal (fein/email) that already
   * belongs to a DIFFERENT customer is blocked by the DB's partial unique index
   * (idx_customer_identity_hard_unique) and surfaces here as IdentitySignalConflictError so the
   * caller can route the source to review instead of silently merging two customers.
   */
  insertSignal(customerId: string, signal: IdentitySignal, sourceId: string, now: string): void {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO customer_identity_signals (id, customer_id, signal_type, signal_value, source_id, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(newId(), customerId, signal.type, signal.value, sourceId, now)
    if (result.changes > 0) return

    // Ignored: something already occupies (customer_id, type, value) or the global hard-unique
    // slot for (type, value). First check whether THIS customer already holds exactly this
    // signal (a legitimate retry) before concluding it is a cross-customer conflict.
    const ownRow = this.db.prepare(
      'SELECT 1 FROM customer_identity_signals WHERE customer_id=? AND signal_type=? AND signal_value=?'
    ).get(customerId, signal.type, signal.value)
    if (ownRow) return

    const other = this.db.prepare(
      'SELECT customer_id FROM customer_identity_signals WHERE signal_type=? AND signal_value=? LIMIT 1'
    ).get(signal.type, signal.value) as { customer_id: string } | undefined
    if (other) throw new IdentitySignalConflictError(signal.type, signal.value, other.customer_id)
    // No row explains the ignore (shouldn't happen given the constraints above) — nothing was
    // written and there is no conflicting owner to report, so treat it as a benign no-op.
  }

  /** Searches hard AND supporting signals; the resolver decides what can auto-resolve. */
  findCustomersBySignal(type: IdentitySignalType, value: string): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT customer_id FROM customer_identity_signals WHERE signal_type=? AND signal_value=? ORDER BY customer_id'
    ).all(type, value) as { customer_id: string }[]).map(r => r.customer_id)
  }

  /**
   * Seed/helper for tests and manual setup: creates a customer and attaches signals in one
   * transaction (AGENTS.md invariant #5 — the customer row and its signal rows must commit or
   * roll back together, so a hard-signal conflict never leaves an orphaned, signal-less customer
   * behind). If `strength` is omitted it is inferred from the signal type.
   */
  createCustomerWithSignals(args: {
    legalName: string | null
    signals: Array<{ type: IdentitySignalType; value: string; strength?: IdentitySignalStrength; sourceId: string }>
    now: string
  }): string {
    const tx = this.db.transaction(() => {
      const customerId = this.createCustomer({ legalName: args.legalName, dba: null, owner: null, now: args.now })
      for (const s of args.signals) {
        this.insertSignal(customerId, { type: s.type, value: s.value, strength: s.strength ?? inferStrength(s.type) }, s.sourceId, args.now)
      }
      return customerId
    })
    return tx()
  }

  /**
   * UPSERT on source_id — a re-resolution overwrites the prior verdict, never collides.
   * `resolvedBy`/`resolvedAt` are optional (default null): the automatic resolver (Task 4)
   * omits them, so its rows stay `resolved_by=NULL, resolved_at=NULL`. The manual identity
   * review client (Task 6) passes the reviewer + Clock timestamp for both the resolved and
   * conflict-rollback verdicts.
   */
  insertResolution(args: {
    sourceId: string
    status: 'resolved' | 'needs_review'
    customerId: string | null
    reason: string
    matchedSignalsJson: string
    now: string
    resolvedBy?: string
    resolvedAt?: string
  }): void {
    this.db.prepare(`
      INSERT INTO source_identity_resolutions
        (source_id, status, customer_id, reason, matched_signals_json, resolved_by, resolved_at, created_at)
      VALUES (@sourceId, @status, @customerId, @reason, @matchedSignalsJson, @resolvedBy, @resolvedAt, @now)
      ON CONFLICT(source_id) DO UPDATE SET
        status = excluded.status,
        customer_id = excluded.customer_id,
        reason = excluded.reason,
        matched_signals_json = excluded.matched_signals_json,
        resolved_by = excluded.resolved_by,
        resolved_at = excluded.resolved_at
    `).run({
      sourceId: args.sourceId,
      status: args.status,
      customerId: args.customerId,
      reason: args.reason,
      matchedSignalsJson: args.matchedSignalsJson,
      now: args.now,
      resolvedBy: args.resolvedBy ?? null,
      resolvedAt: args.resolvedAt ?? null,
    })
  }
}
