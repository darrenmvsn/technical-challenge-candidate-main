import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { FixedClock, addMs } from '../../src/clock.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'

function seedOutbox(db: DB, id: string, nextAttemptAt = '2025-01-01T00:00:00Z') {
  db.prepare(
    `INSERT INTO outbox (id, customer_id, form_type, draft_revision, payload_json, content_hash, status, attempts, next_attempt_at, created_at)
     VALUES (?, 'c1', 'acord_125', 1, '{}', 'h', 'pending', 0, ?, '2025-01-01T00:00:00Z')`
  ).run(id, nextAttemptAt)
}

describe('LeaseClaimer', () => {
  let db: DB, lease: LeaseClaimer
  beforeEach(() => {
    db = openDb()
    migrate(db)
    lease = new LeaseClaimer(db, 'outbox')
  })

  it('claims a pending row and stamps a token', () => {
    seedOutbox(db, 'o1')
    const claimed = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.lock_token).toBeTruthy()
    expect(db.prepare("SELECT status, locked_by, locked_until FROM outbox WHERE id='o1'").get()).toMatchObject({
      status: 'processing',
      locked_by: 'w1',
    })
  })

  it('does not double-claim an unexpired lease', () => {
    seedOutbox(db, 'o1')
    lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    const second = lease.claim('2025-01-02T00:00:10Z', 30_000, 'w2', 10) // within 30s lease
    expect(second).toHaveLength(0)
  })

  it('does not claim a row whose next_attempt_at is not yet due', () => {
    seedOutbox(db, 'o1', '2025-01-02T01:00:00Z') // due an hour after "now" below
    const claimed = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(claimed).toHaveLength(0)
  })

  it('reclaims an expired lease with a fresh token, using a FixedClock to drive expiry', () => {
    seedOutbox(db, 'o1')
    const clock = new FixedClock('2025-01-02T00:00:00Z')
    const leaseMs = 30_000
    const first = lease.claim(clock.now(), leaseMs, 'w1', 10)
    expect(first).toHaveLength(1)

    // Advance the clock past the lease's locked_until (now + leaseMs) — deterministic,
    // no wall-clock reads.
    clock.set(addMs(clock.now(), leaseMs + 1))
    const second = lease.claim(clock.now(), leaseMs, 'w2', 10)
    expect(second).toHaveLength(1)
    expect(second[0]!.lock_token).not.toBe(first[0]!.lock_token)
    expect(db.prepare("SELECT locked_by FROM outbox WHERE id='o1'").get()).toMatchObject({ locked_by: 'w2' })
  })

  it('complete() succeeds for the current token, no-ops for a stale one', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(lease.complete('o1', 'stale-token')).toBe(false)
    expect(lease.complete('o1', c!.lock_token)).toBe(true)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o1'").get()).toMatchObject({ status: 'done' })
  })

  it('complete() no-ops once the row was cancelled (status != processing)', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    db.prepare("UPDATE outbox SET status='cancelled' WHERE id='o1'").run()
    expect(lease.complete('o1', c!.lock_token)).toBe(false)
  })

  it('fail() dead-letters when attempts reach max', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 1)
    expect(lease.fail('o1', c!.lock_token, '2025-01-02T00:05:00Z', 1)).toBe(true)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o1'").get()).toMatchObject({ status: 'dead' })
  })

  it('fail() re-queues as pending with backoff when attempts remain below max', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(lease.fail('o1', c!.lock_token, '2025-01-02T00:05:00Z', 5)).toBe(true)
    const row = db.prepare("SELECT status, attempts, next_attempt_at, lock_token FROM outbox WHERE id='o1'").get()
    expect(row).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: '2025-01-02T00:05:00Z', lock_token: null })
  })

  it('fail() with a stale token affects nothing and returns false (lease already lost)', () => {
    seedOutbox(db, 'o1')
    lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(lease.fail('o1', 'stale-token', '2025-01-02T00:05:00Z', 5)).toBe(false)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o1'").get()).toMatchObject({ status: 'processing' })
  })

  it('rejects a table name outside the closed lease-table allowlist', () => {
    expect(() => new LeaseClaimer(db, 'users' as unknown as 'outbox')).toThrow() // deliberate invalid-table injection to prove the allowlist guard
  })

  describe('cross-connection concurrency (hard case)', () => {
    let dir: string
    let filePath: string
    let dbA: DB
    let dbB: DB

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'lease-claimer-'))
      filePath = join(dir, 'lease.sqlite')
      dbA = openDb(filePath)
      migrate(dbA)
      dbB = openDb(filePath)
    })

    afterEach(() => {
      dbA.close()
      dbB.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('exactly one of two separate connections wins the claim on the same pending row', () => {
      seedOutbox(dbA, 'o1')
      const leaseA = new LeaseClaimer(dbA, 'outbox')
      const leaseB = new LeaseClaimer(dbB, 'outbox')

      const claimedA = leaseA.claim('2025-01-02T00:00:00Z', 30_000, 'workerA', 10)
      const claimedB = leaseB.claim('2025-01-02T00:00:00Z', 30_000, 'workerB', 10)

      const totalClaimed = claimedA.length + claimedB.length
      expect(totalClaimed).toBe(1)
      const winnerToken = claimedA.length === 1 ? claimedA[0]!.lock_token : claimedB[0]!.lock_token
      expect(
        dbA.prepare("SELECT lock_token, locked_by FROM outbox WHERE id='o1'").get()
      ).toMatchObject({ lock_token: winnerToken })
    })

    it('two connections split a multi-row batch with no overlap and no double-claims', () => {
      seedOutbox(dbA, 'o1')
      seedOutbox(dbA, 'o2')
      seedOutbox(dbA, 'o3')
      const leaseA = new LeaseClaimer(dbA, 'outbox')
      const leaseB = new LeaseClaimer(dbB, 'outbox')

      const claimedA = leaseA.claim('2025-01-02T00:00:00Z', 30_000, 'workerA', 10)
      const claimedB = leaseB.claim('2025-01-02T00:00:00Z', 30_000, 'workerB', 10)

      const idsA = claimedA.map((c) => c.id)
      const idsB = claimedB.map((c) => c.id)
      expect(new Set([...idsA, ...idsB]).size).toBe(3) // union covers all rows
      expect(idsA.filter((id) => idsB.includes(id))).toHaveLength(0) // no overlap
    })
  })
})
