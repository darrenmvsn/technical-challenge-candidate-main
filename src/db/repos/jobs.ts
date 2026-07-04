import type { DB } from '../sqlite.js'

export interface JobRow {
  id: string; source_id: string; customer_id: string; status: string; attempts: number
  next_attempt_at: string; locked_until: string | null; lock_token: string | null; locked_by: string | null; created_at: string
}
export interface JobInsert {
  id: string; source_id: string; customer_id: string; next_attempt_at: string; created_at: string
}

export class ProcessingJobsRepo {
  constructor(private db: DB) {}
  insert(row: JobInsert): void {
    this.db.prepare(`INSERT INTO processing_jobs (id,source_id,customer_id,status,attempts,next_attempt_at,created_at)
      VALUES (@id,@source_id,@customer_id,'pending',0,@next_attempt_at,@created_at)`).run(row)
  }
  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(id) as JobRow | undefined
  }
}
