import type { DB } from '../sqlite.js'
import type { FormType } from '../../schema/profile.js'
import type { FillMapping } from '../../schema/forms.js'
import { newId } from '../../util/id.js'

export interface OutboxRow {
  id: string; customer_id: string; form_type: string; draft_revision: number; payload_json: string
  content_hash: string; status: string; attempts: number; next_attempt_at: string
  locked_until: string | null; lock_token: string | null; locked_by: string | null; created_at: string
}

export class OutboxRepo {
  constructor(private db: DB) {}
  // `mapping` is the NESTED fill mapping (README fill_form shape), not the flat review mapping;
  // it is stored verbatim as payload_json and handed to fillForm by the worker.
  enqueue(customerId: string, formType: FormType, draftRevision: number, mapping: FillMapping, contentHash: string, now: string): string {
    const id = newId()
    this.db.prepare(`INSERT INTO outbox (id,customer_id,form_type,draft_revision,payload_json,content_hash,status,attempts,next_attempt_at,created_at)
      VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`).run(id, customerId, formType, draftRevision, JSON.stringify(mapping), contentHash, now, now)
    return id
  }
  pendingForForm(customerId: string, formType: FormType): OutboxRow | undefined {
    return this.db.prepare(
      `SELECT * FROM outbox WHERE customer_id=? AND form_type=? AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1`
    ).get(customerId, formType) as OutboxRow | undefined
  }
  cancel(id: string): void {
    this.db.prepare(`UPDATE outbox SET status='cancelled', locked_until=NULL, lock_token=NULL WHERE id=? AND status IN ('pending','processing')`).run(id)
  }
  get(id: string): OutboxRow | undefined {
    return this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as OutboxRow | undefined
  }
}
