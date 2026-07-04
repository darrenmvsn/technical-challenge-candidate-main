import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite'
import { OutboxRepo } from '../../src/db/repos/outbox'
import { DraftsRepo } from '../../src/db/repos/drafts'
import { LeaseClaimer } from '../../src/lease/leaseClaimer'
import { MemoryBlobStore, type BlobStore } from '../../src/blob/blobStore'
import { OutboxWorker } from '../../src/worker/outboxWorker'
import { FixedClock, addMs } from '../../src/clock'
import { contentHash } from '../../src/util/hash'

// Every row below enqueues the { fein: 'A' } payload for c1/acord_125, so its content_hash is
// the one fillForm will derive (AGENTS.md #9). Production enqueues this matching hash via
// approveForm; the worker now enforces the equality, so tests must seed the real value.
const HASH = contentHash({ customerId: 'c1', formType: 'acord_125', mapping: { fein: 'A' } })

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
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')
    const n = await worker.drainOnce()
    expect(n).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')
    expect(drafts.byId(d.id)!.status).toBe('filled')
    expect(drafts.byId(d.id)!.pdf_ref).toBeTruthy()
  })

  it('a cancelled row does not get filled (fencing)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')
    outbox.cancel(oid) // superseded before the worker runs
    const n = await worker.drainOnce()
    expect(n).toBe(0)
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })

  it('completion+fill are atomic: if markFilled throws, outbox does NOT become done', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')
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
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')

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

  it('T14: a superseded draft revision is completed in the outbox but NOT marked filled (stale-revision guard)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    // Enqueue against revision N...
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')

    // ...then a reprojection races in before the worker runs, superseding revision N with a
    // new revision N+1 (a filled draft would mint a new revision too, but here the current
    // draft isn't filled yet, so upsertProjection overwrites it in place UNLESS we force a
    // fresh revision via newRevision directly, matching "a reprojection raced in").
    const superseded = drafts.newRevision('c1', 'acord_125', { fein: 'B' }, '2025-03-16T00:30:00Z')
    expect(superseded.revision).toBe(d.revision + 1)
    expect(drafts.current('c1', 'acord_125')!.revision).toBe(superseded.revision)

    const n = await worker.drainOnce()

    // The outbox row still completes (done) — the fenced lease claim/complete only cares about
    // the outbox row's own token/status, not the draft's revision.
    expect(n).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')

    // But the CURRENT draft (now at the superseded revision) must NOT be marked filled: the
    // outbox row was enqueued against the stale revision `d.revision`, and
    // `drafts.current(...).revision !== row.draft_revision`, so the worker's guard
    // (`if (draft && draft.revision === row.draft_revision) markFilled(...)`) must skip the
    // markFilled call — no stale fill onto a revision the outbox payload was never generated
    // from.
    const currentAfter = drafts.current('c1', 'acord_125')!
    expect(currentAfter.revision).toBe(superseded.revision)
    expect(currentAfter.status).not.toBe('filled')
    expect(currentAfter.pdf_ref).toBeNull()
  })

  it('does NOT mark filled a draft reprojected to needs_review after enqueue (in-place approved window)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')

    // A correcting transcript reprojects the approved-but-unfilled draft IN PLACE before the
    // worker runs: SAME revision (so the revision guard alone would still pass), content changed,
    // status reset to needs_review. This is the window the newRevision-based T14 test above does
    // NOT exercise — without the status guard the stale payload would fill an unreviewed draft.
    const reset = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-03-16T00:10:00Z')
    expect(reset.id).toBe(d.id)               // in place — same row and revision
    expect(reset.revision).toBe(d.revision)
    expect(reset.status).toBe('needs_review')

    const n = await worker.drainOnce()
    // The outbox row still completes (its blob is content-addressed and harmless), but the draft
    // must NOT be marked filled: an unreviewed draft can never be stamped filled with the stale
    // pre-correction payload. It waits for re-approval, which enqueues a fresh correct fill.
    expect(n).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')
    const after = drafts.byId(d.id)!
    expect(after.status).toBe('needs_review')
    expect(after.pdf_ref).toBeNull()
  })

  it('backs off via addMs (clock-based, no inline Date math) on a retryable failure', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')
    const failingBlob: BlobStore = { put: async () => { throw new Error('blob store down') }, get: async () => null }
    const w = new OutboxWorker({ db, outbox, drafts, blob: failingBlob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'w1' })
    const n = await w.drainOnce()
    expect(n).toBe(0)
    const row = outbox.get(oid)!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.next_attempt_at).toBe(addMs(clock.now(), 5_000))
  })

  it('fails a row whose stored content_hash disagrees with the fill payload (AGENTS.md #9)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    // A desynced row: content_hash claims one thing, the payload hashes to another. The worker
    // must NOT mark it done/filled — the stored hash is the durable identity of the blob.
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'wrong-hash', '2025-03-16T00:00:00Z')
    const n = await worker.drainOnce()
    expect(n).toBe(0)
    expect(outbox.get(oid)!.status).not.toBe('done')
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })

  it('dead-letters once attempts reach maxAttempts', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, HASH, '2025-03-16T00:00:00Z')
    const failingBlob: BlobStore = { put: async () => { throw new Error('blob store down') }, get: async () => null }
    const w = new OutboxWorker({ db, outbox, drafts, blob: failingBlob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'w1', maxAttempts: 1 })
    const n = await w.drainOnce()
    expect(n).toBe(0)
    const row = outbox.get(oid)!
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(1)
  })
})
