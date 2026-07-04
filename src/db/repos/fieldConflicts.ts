import type { DB } from '../sqlite'
import { newId } from '../../util/id'

export interface FieldConflictRow {
  id: string
  customer_id: string
  field_path: string
  current_candidate_id: string
  conflicting_candidate_id: string
  status: 'unresolved' | 'resolved'
  resolved_by_review_version_id: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

export class FieldConflictsRepo {
  constructor(private db: DB) {}

  existsOpen(customerId: string, conflictingCandidateId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM field_conflicts WHERE customer_id=? AND conflicting_candidate_id=? AND status='unresolved'`
    ).get(customerId, conflictingCandidateId)
  }

  /**
   * IDEMPOTENT: `INSERT OR IGNORE` against `idx_field_conflicts_open_unique` (customer_id,
   * conflicting_candidate_id) WHERE status='unresolved' — a retried/duplicate reconcile call
   * that would open the same conflict again is a silent no-op rather than a constraint error.
   */
  insert(customerId: string, fieldPath: string, currentCandidateId: string, conflictingCandidateId: string, now: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO field_conflicts
      (id,customer_id,field_path,current_candidate_id,conflicting_candidate_id,status,created_at)
      VALUES (?,?,?,?,?, 'unresolved', ?)`)
      .run(newId(), customerId, fieldPath, currentCandidateId, conflictingCandidateId, now)
  }

  listUnresolved(customerId: string): FieldConflictRow[] {
    return this.db.prepare(`SELECT * FROM field_conflicts WHERE customer_id=? AND status='unresolved'`)
      .all(customerId) as FieldConflictRow[]
  }

  get(id: string): FieldConflictRow | undefined {
    return this.db.prepare('SELECT * FROM field_conflicts WHERE id=?').get(id) as FieldConflictRow | undefined
  }

  resolve(id: string, reviewVersionId: string, by: string, at: string): void {
    this.db.prepare(`UPDATE field_conflicts
      SET status='resolved', resolved_by_review_version_id=?, resolved_by=?, resolved_at=?
      WHERE id=?`).run(reviewVersionId, by, at, id)
  }
}
