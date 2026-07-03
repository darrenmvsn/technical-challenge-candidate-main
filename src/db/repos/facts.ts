import type { DB } from '../sqlite.js'
import type { Fact } from '../../schema/profile.js'
import { selectCurrentFact } from '../../profile/factSelector.js'

export class FactsRepo {
  constructor(private db: DB) {}

  insertMany(facts: Fact[]): void {
    // OR IGNORE: fact ids are deterministic per (customer, field_path, source_id), so
    // re-extracting the same source is idempotent and never clobbers a human-approved row.
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO facts
      (id,customer_id,field_path,value_json,presence,confidence,evidence_quote,evidence_span_start,
       evidence_span_end,match_quality,source_id,source_date,extracted_at,review_status,
       reviewed_value_json,reviewed_by,reviewed_at,superseded_by)
      VALUES (@id,@customer_id,@field_path,@value_json,@presence,@confidence,@evidence_quote,
       @evidence_span_start,@evidence_span_end,@match_quality,@source_id,@source_date,@extracted_at,
       @review_status,@reviewed_value_json,@reviewed_by,@reviewed_at,@superseded_by)`)
    const tx = this.db.transaction((rows: Fact[]) => { for (const r of rows) stmt.run(r) })
    tx(facts)
  }

  byField(customerId: string, fieldPath: string): Fact[] {
    return this.db.prepare('SELECT * FROM facts WHERE customer_id=? AND field_path=?')
      .all(customerId, fieldPath) as Fact[]
  }

  allFieldPaths(customerId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT field_path FROM facts WHERE customer_id=?')
      .all(customerId) as { field_path: string }[]).map(r => r.field_path)
  }

  /** field_path -> current Fact (per selectCurrentFact). */
  currentMap(customerId: string): Map<string, Fact> {
    const all = this.db.prepare('SELECT * FROM facts WHERE customer_id=? AND superseded_by IS NULL')
      .all(customerId) as Fact[]
    const byPath = new Map<string, Fact[]>()
    for (const f of all) { (byPath.get(f.field_path) ?? byPath.set(f.field_path, []).get(f.field_path)!).push(f) }
    const out = new Map<string, Fact>()
    for (const [path, cands] of byPath) { const cur = selectCurrentFact(cands); if (cur) out.set(path, cur) }
    return out
  }

  /**
   * Approve a fact, optionally overriding its value (a human correction). Does NOT change
   * `presence`: approving a non-present fact with `reviewedValueJson=null` yields the
   * `approved_blank` read state (sign-off on leaving it blank). Reviewer-initiated
   * present→not_applicable is a deferred extension — see Explicit Scope / Deferrals.
   */
  markApproved(id: string, reviewedValueJson: string | null, by: string, at: string): void {
    this.db.prepare(`UPDATE facts SET review_status='approved', reviewed_value_json=?, reviewed_by=?, reviewed_at=? WHERE id=?`)
      .run(reviewedValueJson, by, at, id)
  }

  /** Mark a fact superseded (reserved for explicit ledger tombstoning; selection ignores these). */
  supersede(id: string, by: string): void {
    this.db.prepare('UPDATE facts SET superseded_by=? WHERE id=?').run(by, id)
  }

  get(id: string): Fact | undefined {
    return this.db.prepare('SELECT * FROM facts WHERE id=?').get(id) as Fact | undefined
  }
}
