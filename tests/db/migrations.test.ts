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

  it('rejects an invalid status on processing_jobs via CHECK constraint', () => {
    const db = openDb()
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO processing_jobs (id, source_id, customer_id, status, next_attempt_at, created_at)
           VALUES ('j1','s1','c1','bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
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
})
