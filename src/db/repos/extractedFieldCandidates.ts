import type { DB } from '../sqlite'
import type { ExtractedFieldCandidate } from '../../schema/profile'
import { selectCurrentCandidate } from '../../profile/candidateSelector'

export class ExtractedFieldCandidatesRepo {
  constructor(private db: DB) {}

  insertMany(candidates: ExtractedFieldCandidate[]): void {
    // OR IGNORE: candidate ids are deterministic per (customer, field_path, source_id), so
    // re-extracting the same source is idempotent and never clobbers an existing row.
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO extracted_field_candidates
      (id,customer_id,field_path,value_json,presence,confidence,evidence_quote,evidence_span_start,
       evidence_span_end,match_quality,source_id,source_date,extracted_at,superseded_by)
      VALUES (@id,@customer_id,@field_path,@value_json,@presence,@confidence,@evidence_quote,
       @evidence_span_start,@evidence_span_end,@match_quality,@source_id,@source_date,@extracted_at,
       @superseded_by)`)
    const tx = this.db.transaction((rows: ExtractedFieldCandidate[]) => { for (const r of rows) stmt.run(r) })
    tx(candidates)
  }

  byField(customerId: string, fieldPath: string): ExtractedFieldCandidate[] {
    return this.db.prepare('SELECT * FROM extracted_field_candidates WHERE customer_id=? AND field_path=?')
      .all(customerId, fieldPath) as ExtractedFieldCandidate[]
  }

  allFieldPaths(customerId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT field_path FROM extracted_field_candidates WHERE customer_id=?')
      .all(customerId) as { field_path: string }[]).map(r => r.field_path)
  }

  /** field_path -> current ExtractedFieldCandidate (per selectCurrentCandidate). */
  currentCandidateMap(customerId: string): Map<string, ExtractedFieldCandidate> {
    const all = this.db.prepare('SELECT * FROM extracted_field_candidates WHERE customer_id=? AND superseded_by IS NULL')
      .all(customerId) as ExtractedFieldCandidate[]
    const byPath = new Map<string, ExtractedFieldCandidate[]>()
    for (const c of all) { (byPath.get(c.field_path) ?? byPath.set(c.field_path, []).get(c.field_path)!).push(c) }
    const out = new Map<string, ExtractedFieldCandidate>()
    for (const [path, cands] of byPath) { const cur = selectCurrentCandidate(cands); if (cur) out.set(path, cur) }
    return out
  }

  /** Mark a candidate superseded (reserved for explicit ledger tombstoning; selection ignores these). */
  supersede(id: string, by: string): void {
    this.db.prepare('UPDATE extracted_field_candidates SET superseded_by=? WHERE id=?').run(by, id)
  }

  get(id: string): ExtractedFieldCandidate | undefined {
    return this.db.prepare('SELECT * FROM extracted_field_candidates WHERE id=?').get(id) as ExtractedFieldCandidate | undefined
  }
}
