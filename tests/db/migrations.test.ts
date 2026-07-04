import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../../src/db/sqlite.js'

interface SqliteMasterRow {
  name: string
}

describe('migrate', () => {
  it('creates every table', () => {
    const db = openDb()
    migrate(db)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as SqliteMasterRow).name)
    for (const t of [
      'sources',
      'processing_jobs',
      'facts',
      'collection_items',
      'form_drafts',
      'draft_field_bindings',
      'outbox',
      'conflicts',
      'customers',
    ]) {
      expect(names).toContain(t)
    }
  })

  it('is idempotent', () => {
    const db = openDb()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
  })

  it('openDb creates the parent directory for a file-backed database path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acord-db-parent-'))
    const dbPath = join(dir, 'nested', 'acord.db')
    try {
      const db = openDb(dbPath)
      migrate(db)
      expect(db.prepare('SELECT 1 ok').get()).toMatchObject({ ok: 1 })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid presence value on facts via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO facts (id, customer_id, field_path, value_json, presence, confidence, match_quality, source_id, source_date, extracted_at)
           VALUES ('f1','c1','x', null, 'bogus', 0.5, 'none', 's1', '2026-01-01', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow()
  })

  it('allows sources and jobs before customer identity is resolved', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO sources
            (id,type,source_date,received_at,raw_json,checksum,status)
            VALUES ('src_001','call_transcript','2025-03-12T10:30:00Z','2025-03-12T10:31:00Z','{}','h','received')`
        )
        .run()
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs
            (id,source_id,status,attempts,next_attempt_at,created_at)
            VALUES ('job_001','src_001','pending',0,'2025-03-12T10:31:00Z','2025-03-12T10:31:00Z')`
        )
        .run()
    ).not.toThrow()
  })

  it('rejects an invalid status on processing_jobs via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (id, source_id, status, next_attempt_at, created_at)
           VALUES ('j1','s1','bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow()
  })

  it('rejects an invalid status on sources via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO sources (id,type,source_date,received_at,raw_json,checksum,status)
           VALUES ('s_bogus','call_transcript','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}','hb','bogus')`
        )
        .run()
    ).toThrow()
  })

  it('rejects an invalid status on outbox via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO outbox (id, customer_id, form_type, draft_revision, payload_json, content_hash, status, next_attempt_at, created_at)
           VALUES ('o1','c1','acord_125',1,'{}','h','bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow()
  })

  it('rejects an invalid form_type on form_drafts via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO form_drafts (id, customer_id, form_type, revision, projected_json, created_at, updated_at)
           VALUES ('d1','c1','acord_999',1,'{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow()
  })

  it('rejects an invalid status on conflicts via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO conflicts (id, customer_id, field_path, current_fact_id, conflicting_fact_id, status, created_at)
           VALUES ('cf1','c1','x','f1','f2','bogus','2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow()
  })

  it('accepts valid enum values on all constrained columns', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO facts (id, customer_id, field_path, value_json, presence, confidence, match_quality, source_id, source_date, extracted_at, review_status)
           VALUES ('f2','c1','x', null, 'missing', 0.5, 'none', 's1', '2026-01-01', '2026-01-01T00:00:00.000Z', 'needs_review')`
        )
        .run()
    ).not.toThrow()
  })

  it('enforces checksum uniqueness on sources at the database layer', () => {
    const db = openDb()
    migrate(db)
    db.prepare(
      `INSERT INTO sources (id, customer_id, type, source_date, received_at, raw_json, checksum, status)
       VALUES ('s1','c1','call_transcript','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}','same','received')`
    ).run()
    expect(() =>
      db.prepare(
        `INSERT INTO sources (id, customer_id, type, source_date, received_at, raw_json, checksum, status)
         VALUES ('s2','c1','call_transcript','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}','same','received')`
      ).run()
    ).toThrow()
  })
})
