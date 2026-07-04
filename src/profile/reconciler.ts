import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { ConflictsRepo } from '../db/repos/conflicts.js'
import type { Fact, FormType } from '../schema/profile.js'
import { selectCurrentFact } from './factSelector.js'
import { boundScalarPaths, effectiveValueJson } from '../forms/renderers.js'
import { factIdFor } from '../util/hash.js'

export interface ReconcileCtx {
  db: DB; facts: FactsRepo; conflicts: ConflictsRepo; clock: Clock
  customerId: string; formTypes: FormType[]
}

/**
 * Sentinel `source_date` for materialized `missing` placeholder facts (fixes a Critical
 * whole-branch-review finding: silent data loss). A materialized "missing" is not a dated
 * observation — it is reconcile's bookkeeping that a bound field has no fact yet — so it must
 * always LOSE the invariant-#7 source_date tiebreak to any real (present/needs_follow_up)
 * fact, no matter how much later that real fact is discovered. Using `clock.now()` (the
 * reconcile PROCESSING time) here was the bug: a recent processing timestamp lexicographically
 * beats an older, real transcript/call `source_date`, so an empty placeholder could shadow a
 * genuine extracted value. This sentinel is a valid-shaped ISO-8601 UTC string that sorts
 * lexicographically before every real date, so it never wins the source_date comparison in
 * `selectCurrentFact` (approval is still checked first, so an APPROVED missing fact is
 * unaffected — approval outranks source_date regardless of this constant).
 */
export const MISSING_SOURCE_DATE = '0000-01-01T00:00:00.000Z'

/**
 * Deviation from the brief's literal reference code (documented per task instructions):
 * the reference `reconcile()` ran the conflict-insert loop and the missing-fact
 * materialization as separate, unwrapped repo calls. AGENTS.md invariant #5 ("every write
 * path spanning >1 row is wrapped in a single transaction") and #12 ("reconciliation/conflict
 * writes ... commit in one transaction... if the fence fails, none of those domain writes may
 * persist") both require this to be atomic: a reconcile() call can write MULTIPLE conflict
 * rows (one per disagreeing field) plus multiple missing-fact rows, and a failure partway
 * through must not leave a partial write. Proof of the bug (revert-and-fail): with the
 * unwrapped version, a forced exception on the 2nd of 2 conflict inserts left the 1st conflict
 * committed (`tests/profile/reconciler.test.ts` "is all-or-nothing..." failed with 1 row
 * persisted instead of 0). The fix wraps the whole body in one `ctx.db.transaction(...)`;
 * `FactsRepo.insertMany`'s own `db.transaction(...)` nests via a SAVEPOINT (better-sqlite3
 * supports this natively), so it composes into the same atomic unit. No external I/O is
 * introduced — reconcile only reads/writes local SQLite rows and reads the injected Clock.
 */
export function reconcile(ctx: ReconcileCtx): void {
  const { db, facts, conflicts, clock, customerId } = ctx
  const now = clock.now()

  const run = db.transaction(() => {
    // 1. Conflict detection per field: an approved current + a newer machine candidate that disagrees.
    for (const fieldPath of facts.allFieldPaths(customerId)) {
      const cands = facts.byField(customerId, fieldPath).filter(f => f.superseded_by === null)
      const current = selectCurrentFact(cands)
      if (!current || current.review_status !== 'approved') continue
      for (const c of cands) {
        if (c.id === current.id || c.review_status === 'approved') continue
        const disagrees = c.value_json !== effectiveValueJson(current)
        const isNewer = c.source_date > current.source_date
        if (disagrees && isNewer && !conflicts.existsOpen(customerId, c.id)) {
          conflicts.insert(customerId, fieldPath, current.id, c.id, now)
        }
      }
    }

    // 2. Materialize a missing fact for every bound scalar path with no fact yet.
    const known = new Set(facts.allFieldPaths(customerId))
    const missing: Fact[] = []
    const bound = new Set(ctx.formTypes.flatMap(ft => boundScalarPaths(ft)))
    for (const path of bound) {
      if (known.has(path)) continue
      missing.push({
        id: factIdFor(customerId, path, 'system'), customer_id: customerId, field_path: path, value_json: null,
        presence: 'missing', confidence: 0, evidence_quote: null, evidence_span_start: null,
        evidence_span_end: null, match_quality: 'none', source_id: 'system', source_date: MISSING_SOURCE_DATE,
        extracted_at: now, review_status: 'needs_review', reviewed_value_json: null,
        reviewed_by: null, reviewed_at: null, superseded_by: null,
      })
    }
    if (missing.length) facts.insertMany(missing)
  })
  run()
}
