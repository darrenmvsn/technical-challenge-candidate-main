import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { buildWebhookApp } from '../../src/ingest/webhook.js'
import { FixedClock } from '../../src/clock.js'

const body = {
  id: 'src_001', type: 'call_transcript', date: '2025-03-12T10:30:00Z',
  participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: 'hello',
}

function countRows(db: DB, table: 'sources' | 'processing_jobs'): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n
}

describe('POST /webhook/transcript', () => {
  let db: DB, app: ReturnType<typeof buildWebhookApp>, woke: number
  beforeEach(() => {
    db = openDb(); migrate(db)
    woke = 0
    app = buildWebhookApp({ db, clock: new FixedClock('2025-03-12T10:31:00Z'), wake: () => { woke++ } })
  })

  it('persists source + job (customer_id null) and returns 202', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).job_id).toBeTruthy()
    expect(countRows(db, 'sources')).toBe(1)
    expect(countRows(db, 'processing_jobs')).toBe(1)
    // Identity is unresolved at ingest: the source is stored customer-agnostic.
    expect((db.prepare('SELECT customer_id FROM sources WHERE id=?').get(body.id) as { customer_id: string | null }).customer_id).toBeNull()
    expect(woke).toBe(1) // processor nudged exactly once for a real ingest
  })

  it('dedupes a re-delivered identical source', async () => {
    await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    const res2 = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body).deduped).toBe(true)
    expect(countRows(db, 'sources')).toBe(1)
    expect(countRows(db, 'processing_jobs')).toBe(1)
    expect(woke).toBe(1) // NOT nudged again for a deduped redelivery
  })

  it('dedupes a redelivery with the SAME content under a DIFFERENT source id', async () => {
    await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    const res2 = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { ...body, id: 'src_002' },
    })
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body).deduped).toBe(true)
    expect(countRows(db, 'sources')).toBe(1)
  })

  it('rejects a malformed payload with 4xx and creates NO rows (AGENTS.md #10)', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: { id: 'src_001' } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(countRows(db, 'sources')).toBe(0)
    expect(countRows(db, 'processing_jobs')).toBe(0)
    expect(woke).toBe(0)
  })

  it('rejects a payload with the wrong field types with 4xx and creates NO rows', async () => {
    const res = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { id: 123, type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['x'], content: 'hi' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(countRows(db, 'sources')).toBe(0)
    expect(countRows(db, 'processing_jobs')).toBe(0)
  })

  it('rejects a payload with no participants with 4xx and creates NO rows', async () => {
    const res = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { ...body, participants: [] },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(countRows(db, 'sources')).toBe(0)
    expect(countRows(db, 'processing_jobs')).toBe(0)
  })

  it('rejects a non-ISO date with 4xx and creates NO rows (AGENTS.md #3/#10)', async () => {
    // A malformed source_date would sort lexicographically above real ISO dates and permanently
    // hijack selectCurrentCandidate — reject it at the boundary before it is ever persisted.
    const res = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { ...body, date: 'zzzz' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(countRows(db, 'sources')).toBe(0)
    expect(countRows(db, 'processing_jobs')).toBe(0)
    expect(woke).toBe(0)
  })

  it('does not leak a stack trace in the error response', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: { nope: true } })
    expect(res.body).not.toMatch(/at .*\(.*:\d+:\d+\)/) // no "at foo (file.ts:1:1)" stack frame text
    expect(res.body).not.toContain('.ts:')
  })
})
