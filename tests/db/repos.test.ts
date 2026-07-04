import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite'
import { DraftsRepo } from '../../src/db/repos/drafts'
import { OutboxRepo } from '../../src/db/repos/outbox'

describe('DraftsRepo + OutboxRepo', () => {
  let db: DB, drafts: DraftsRepo, outbox: OutboxRepo
  beforeEach(() => { db = openDb(); migrate(db); drafts = new DraftsRepo(db); outbox = new OutboxRepo(db) })

  it('creates revision 1 then a new revision that supersedes the old', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    expect(r1.revision).toBe(1)
    drafts.markFilled(r1.id, 'pdf/x', '2025-01-01T00:01:00Z')
    const r2 = drafts.newRevision('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(2)
    const oldRow = drafts.byId(r1.id)!
    expect(oldRow.status).toBe('filled')                       // stays filled
    expect(oldRow.superseded_by_revision).toBe(2)              // recorded separately
    expect(drafts.current('c1', 'acord_125')!.revision).toBe(2)
  })

  it('upsertProjection over a FILLED draft mints a new revision and supersedes the old', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    drafts.markFilled(r1.id, 'pdf/x', '2025-01-01T00:01:00Z')
    // A later transcript reprojects the SAME form via upsertProjection (not newRevision).
    const r2 = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(2)
    expect(r2.status).toBe('needs_review')                     // must be re-reviewed
    expect(drafts.byId(r1.id)!.status).toBe('filled')          // old stays filled (immutable)
    expect(drafts.byId(r1.id)!.superseded_by_revision).toBe(2) // no dangling current row
    // Exactly one current row for the (customer, form).
    const currentRows = db.prepare(
      "SELECT COUNT(*) n FROM form_drafts WHERE customer_id='c1' AND form_type='acord_125' AND superseded_by_revision IS NULL"
    ).get() as { n: number }
    expect(currentRows.n).toBe(1)
  })

  it('upsertProjection over a non-filled draft overwrites in place (same revision)', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    drafts.approve(r1.id, 'sarah', '2025-01-01T00:00:30Z')
    const r2 = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(1)                                 // same row
    expect(r2.status).toBe('needs_review')                     // approval invalidated by new data
    expect(r2.approved_by).toBeNull()                          // stale approval metadata cleared on reproject
    expect(r2.approved_at).toBeNull()
    expect(JSON.parse(r2.projected_json).fein).toBe('B')
  })

  it('enqueues and finds a pending outbox row, then cancels it', () => {
    const id = outbox.enqueue('c1', 'acord_125', 1, { fein: 'A' }, 'hash', '2025-01-01T00:00:00Z')
    expect(outbox.pendingForForm('c1', 'acord_125')!.id).toBe(id)
    outbox.cancel(id)
    expect(outbox.pendingForForm('c1', 'acord_125')).toBeUndefined()
    expect(outbox.get(id)!.status).toBe('cancelled')
  })

  it('persists and reads per-draft field bindings', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', {}, '2025-01-01T00:00:00Z')
    drafts.saveBindings(r1.id, [{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.abc.amount' }])
    expect(drafts.getBindings(r1.id)).toEqual([{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.abc.amount' }])
  })

  // AGENTS.md invariant #5: every write path spanning >1 row is wrapped in ONE transaction.
  // newRevision() does two row writes (insert the new revision + supersede the old row) — this
  // proves that if the second write fails, the first is rolled back too (no dangling orphan
  // revision left behind). See task-12-report.md for the revert-and-fail proof against the
  // brief's unwrapped reference implementation.
  it('newRevision is atomic: a failure superseding the old row rolls back the new insert', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    drafts.markFilled(r1.id, 'pdf/x', '2025-01-01T00:01:00Z')
    const spy = vi.spyOn(drafts, 'supersede').mockImplementation(() => { throw new Error('boom') }) // deliberate failure injection to prove atomicity
    expect(() => drafts.newRevision('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')).toThrow('boom')
    spy.mockRestore()
    const rows = db.prepare(
      "SELECT COUNT(*) n FROM form_drafts WHERE customer_id='c1' AND form_type='acord_125'"
    ).get() as { n: number }
    expect(rows.n).toBe(1) // only r1 remains — the aborted revision-2 insert did not persist
    expect(drafts.current('c1', 'acord_125')!.id).toBe(r1.id) // r1 is still current (never superseded)
  })
})
