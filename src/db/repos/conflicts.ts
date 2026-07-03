import type { DB } from '../sqlite.js'
import { newId } from '../../util/id.js'

export interface ConflictRow {
  id: string; customer_id: string; field_path: string; current_fact_id: string
  conflicting_fact_id: string; status: 'unresolved' | 'resolved'; resolved_by: string | null
  resolved_at: string | null; created_at: string
}

export class ConflictsRepo {
  constructor(private db: DB) {}
  existsOpen(customerId: string, conflictingFactId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM conflicts WHERE customer_id=? AND conflicting_fact_id=? AND status='unresolved'`
    ).get(customerId, conflictingFactId)
  }
  insert(customerId: string, fieldPath: string, currentFactId: string, conflictingFactId: string, now: string): void {
    this.db.prepare(`INSERT INTO conflicts (id,customer_id,field_path,current_fact_id,conflicting_fact_id,status,created_at)
      VALUES (?,?,?,?,?, 'unresolved', ?)`).run(newId(), customerId, fieldPath, currentFactId, conflictingFactId, now)
  }
  listUnresolved(customerId: string): ConflictRow[] {
    return this.db.prepare(`SELECT * FROM conflicts WHERE customer_id=? AND status='unresolved'`).all(customerId) as ConflictRow[]
  }
  resolve(id: string, by: string, at: string): void {
    this.db.prepare(`UPDATE conflicts SET status='resolved', resolved_by=?, resolved_at=? WHERE id=?`).run(by, at, id)
  }
}
