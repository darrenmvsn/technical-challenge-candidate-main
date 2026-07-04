import type { DB } from '../sqlite.js'
import { ProcessingJobsRepo, type JobInsert } from './jobs.js'

export interface SourceRow {
  id: string; customer_id: string; type: string; source_date: string; received_at: string
  raw_json: string; checksum: string; status?: string
}

export class SourcesRepo {
  constructor(private db: DB) {}
  insert(row: SourceRow): void {
    this.db.prepare(`INSERT INTO sources (id,customer_id,type,source_date,received_at,raw_json,checksum,status)
      VALUES (@id,@customer_id,@type,@source_date,@received_at,@raw_json,@checksum,@status)`)
      .run({ ...row, status: row.status ?? 'received' })
  }
  get(id: string): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined
  }
  existsById(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(id)
  }
  existsByChecksum(checksum: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sources WHERE checksum=?').get(checksum)
  }
}

/**
 * Durable ingest: source + its processing job are committed atomically in ONE transaction
 * (AGENTS.md invariant #5). Duplicate ingest — the SAME source `id` (e.g. a retried request)
 * OR the SAME `checksum` under a fresh id (e.g. a webhook redelivery that mints new ids) — is
 * deduped explicitly: the whole call becomes a no-op (no crash, no duplicate source row, no
 * duplicate/orphaned job row referencing a source that was never inserted).
 *
 * Deviation from the brief's literal reference code (documented per task instructions): the
 * reference `insertSourceAndJob` unconditionally INSERTed both rows with no pre-check. Calling
 * it twice with the same source id would throw a UNIQUE constraint violation on `sources.id`
 * (a crash, not a handled duplicate); calling it with a different id but the same `checksum`
 * would silently create a second source+job pair for identical content. Both violate this
 * ticket's explicit requirement ("duplicate ingest ... handled explicitly (dedupe, no crash)
 * and does NOT create duplicate sources/jobs"). The fix checks `existsById`/`existsByChecksum`
 * inside the same transaction before writing and returns early (no-op) on either match — see
 * `tests/worker/processor.test.ts` "insertSourceAndJob (durable ingest)" for the proof.
 *
 * Task 16 addition: the return value reports whether THIS call actually performed the insert.
 * The webhook route (`src/ingest/webhook.ts`) does its own `existsById`/`existsByChecksum`
 * pre-check for the common sequential-redelivery case, but that pre-check is a
 * check-THEN-insert race under concurrent requests: two requests for the same new source can
 * both pass the pre-check before either has committed. Without this return value, the loser of
 * that race would still call `insertSourceAndJob`, get no-op'd by the in-transaction dedupe
 * below, yet the route would have no way to know that — and would (per the brief's literal
 * handler) reply `202 { job_id }` for a job that was never inserted, a lying response. Because
 * the in-transaction check+insert here is atomic (single `db.transaction`), `inserted` is a
 * reliable signal of what actually happened; the route uses it, not the pre-check, to decide
 * between `202` and the deduped `200`.
 */
export function insertSourceAndJob(db: DB, args: { source: SourceRow; job: JobInsert }): { inserted: boolean } {
  const sources = new SourcesRepo(db)
  const jobs = new ProcessingJobsRepo(db)
  const tx = db.transaction(() => {
    if (sources.existsById(args.source.id) || sources.existsByChecksum(args.source.checksum)) return false
    sources.insert(args.source)
    jobs.insert(args.job)
    return true
  })
  return { inserted: tx.immediate() }
}
