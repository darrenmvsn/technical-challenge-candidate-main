import { describe, it, expect, beforeEach } from 'vitest'
import transcriptFixture from '../../transcripts.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { buildWebhookApp } from '../../src/ingest/webhook.js'
import { FixedClock } from '../../src/clock.js'

function countRows(db: DB, table: 'sources' | 'processing_jobs'): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n
}

describe('POST /webhook/transcript (raw transcript contract)', () => {
  let db: DB, app: ReturnType<typeof buildWebhookApp>
  beforeEach(() => {
    db = openDb(); migrate(db)
    app = buildWebhookApp({ db, clock: new FixedClock('2025-03-12T10:31:00Z'), wake: () => {} })
  })

  it('accepts the raw transcript shape from transcripts.json without customer_id', async () => {
    const [source] = transcriptFixture
    const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: source })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).job_id).toBeTruthy()
    expect(countRows(db, 'sources')).toBe(1)
    expect(countRows(db, 'processing_jobs')).toBe(1)
    const row = db.prepare('SELECT customer_id, raw_json FROM sources WHERE id=?').get(source!.id) as { customer_id: string | null; raw_json: string }
    expect(row.customer_id).toBeNull()
    expect(JSON.parse(row.raw_json).content).toContain('Coastal Roofing LLC')
  })
})
