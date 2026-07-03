import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MemoryBlobStore, type BlobStore } from '../../src/blob/blobStore.js'
import { OutboxWorker } from '../../src/worker/outboxWorker.js'
import { FixedClock, addMs } from '../../src/clock.js'

describe('OutboxWorker.drainOnce', () => {
  let db: DB, outbox: OutboxRepo, drafts: DraftsRepo, blob: MemoryBlobStore, lease: LeaseClaimer, worker: OutboxWorker
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  beforeEach(() => {
    clock.set('2025-03-16T00:00:00Z')
    db = openDb(); migrate(db)
    outbox = new OutboxRepo(db); drafts = new DraftsRepo(db); blob = new MemoryBlobStore()
    lease = new LeaseClaimer(db, 'outbox')
    worker = new OutboxWorker({ db, outbox, drafts, blob, lease, clock, workerId: 'w1' })
  })

  it('fills a pending row and marks the draft filled', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const n = await worker.drainOnce()
    expect(n).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')
    expect(drafts.byId(d.id)!.status).toBe('filled')
    expect(drafts.byId(d.id)!.pdf_ref).toBeTruthy()
  })

  it('a cancelled row does not get filled (fencing)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    outbox.cancel(oid) // superseded before the worker runs
    const n = await worker.drainOnce()
    expect(n).toBe(0)
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })

  it('completion+fill are atomic: if markFilled throws, outbox does NOT become done', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const orig = drafts.markFilled.bind(drafts)
    ;(drafts as any).markFilled = () => { throw new Error('crash after complete()') } // deliberate failure injection: force the atomic commit to roll back after complete() would have run
    const n = await worker.drainOnce()
    ;(drafts as any).markFilled = orig // deliberate: restore real implementation after failure injection above
    expect(n).toBe(0)
    // The txn rolled back: the row is NOT 'done' and NOT stranded — it stays claimable.
    expect(outbox.get(oid)!.status).not.toBe('done')
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })

  it('FORCED DOUBLE-RUN: a lost-lease crash between fillForm and commit, followed by a real retry, yields exactly ONE effective fill', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')

    const putKeys: string[] = []
    const realPut = blob.put.bind(blob)
    blob.put = async (key, bytes) => { putKeys.push(key); return realPut(key, bytes) } // spy only: records every blob write without changing behavior

    const realComplete = lease.complete.bind(lease)
    ;(lease as any).complete = () => false // deliberate failure injection: force run #1's fenced completion to report a lost lease, simulating a crash/reclaim after fillForm already ran

    // Run #1: fillForm executes and writes a blob, but the atomic {outbox done + draft filled}
    // commit is forced to fail (lost lease) — per AGENTS.md #5/#12, fillForm ran OUTSIDE the
    // transaction, so its result is discarded on rollback; nothing is recorded as done/filled.
    const firstRun = await worker.drainOnce()
    ;(lease as any).complete = realComplete // deliberate: restore the real fenced complete() for the retry

    expect(firstRun).toBe(0)
    expect(outbox.get(oid)!.status).toBe('pending') // fail()'d with backoff — not stranded 'processing'
    expect(outbox.get(oid)!.attempts).toBe(1)
    expect(drafts.byId(d.id)!.status).not.toBe('filled')

    // Advance the clock past the backoff window so the row is due again, then let the SAME
    // outbox row be reprocessed for real — the forced "double run" on one claimable row.
    clock.set(addMs(clock.now(), 5_000))
    const secondRun = await worker.drainOnce()

    expect(secondRun).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')
    const filled = drafts.byId(d.id)!
    expect(filled.status).toBe('filled')
    expect(filled.pdf_ref).toBeTruthy()

    // fillForm ran twice (once per attempt) but is content-addressed: both writes target the
    // SAME blob key — one effective fill, no duplicate blob, no duplicate completion.
    expect(putKeys).toHaveLength(2)
    expect(new Set(putKeys).size).toBe(1)
    expect(filled.pdf_ref).toBe(putKeys[0])
    expect(await blob.get(filled.pdf_ref!)).toEqual(await blob.get(putKeys[1]!))

    // Immutability: a filled draft's own content cannot be mutated further — reprojecting
    // mints a NEW revision (a new row) rather than touching the filled row's fill state.
    // `superseded_by_revision` legitimately changes to point at that new revision, but
    // status/pdf_ref/projected_json — the actual filled content — never do.
    const reprojected = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-03-17T00:00:00Z')
    expect(reprojected.id).not.toBe(filled.id)
    const afterReproject = drafts.byId(d.id)!
    expect(afterReproject.status).toBe('filled')
    expect(afterReproject.pdf_ref).toBe(filled.pdf_ref)
    expect(afterReproject.projected_json).toBe(filled.projected_json)
    expect(afterReproject.superseded_by_revision).toBe(reprojected.revision)
  })

  it('backs off via addMs (clock-based, no inline Date math) on a retryable failure', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const failingBlob: BlobStore = { put: async () => { throw new Error('blob store down') }, get: async () => null }
    const w = new OutboxWorker({ db, outbox, drafts, blob: failingBlob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'w1' })
    const n = await w.drainOnce()
    expect(n).toBe(0)
    const row = outbox.get(oid)!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.next_attempt_at).toBe(addMs(clock.now(), 5_000))
  })

  it('dead-letters once attempts reach maxAttempts', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const failingBlob: BlobStore = { put: async () => { throw new Error('blob store down') }, get: async () => null }
    const w = new OutboxWorker({ db, outbox, drafts, blob: failingBlob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'w1', maxAttempts: 1 })
    const n = await w.drainOnce()
    expect(n).toBe(0)
    const row = outbox.get(oid)!
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(1)
  })
})
