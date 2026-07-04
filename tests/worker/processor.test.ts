import { describe, it, expect, beforeEach } from 'vitest'
import v1Fixture from '../fixtures/llm/coastal_v1.json'
import v2Fixture from '../fixtures/llm/coastal_v2.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { SourcesRepo, insertSourceAndJob } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import { FieldConflictsRepo } from '../../src/db/repos/fieldConflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { CustomerIdentityRepo } from '../../src/db/repos/customerIdentity.js'
import { CustomerResolver } from '../../src/identity/customerResolver.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MockLlmClient } from '../../src/extraction/llmClient.js'
import { Processor } from '../../src/worker/processor.js'
import { FixedClock } from '../../src/clock.js'
import { newId } from '../../src/util/id.js'

// A source is now ingested customer-agnostic; the processor resolves identity from the transcript.
// These canned envelopes carry a hard FEIN signal whose evidence appears verbatim (once) in the
// source content, so every source below resolves to the SAME customer (created on the first, then
// matched on the rest). `withFein` appends that same FEIN to a content string so the resolver's
// anti-hallucination guard admits it. `content` shapes are wrapped in the full raw transcript JSON
// (mirrors what the webhook persists via Task 2).
const feinField = { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' }
const v1id = { ...v1Fixture, fein: feinField }
const v2id = { ...v2Fixture, fein: feinField }
const withFein = (s: string): string => `${s} Our FEIN is 12-3456789.`
const rawJson = (content: string): string =>
  JSON.stringify({ id: 'src', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content })

describe('insertSourceAndJob (durable ingest)', () => {
  let db: DB
  beforeEach(() => { db = openDb(); migrate(db) })

  function countRows(table: 'sources' | 'processing_jobs'): number {
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
  }

  it('writes source + job atomically and re-ingesting the SAME id is a deduped no-op (no crash, no dup rows)', () => {
    const sourceId = newId(), jobId = newId()
    const args = {
      source: { id: sourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'abc' },
      job: { id: jobId, source_id: sourceId, next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    }
    insertSourceAndJob(db, args)
    expect(countRows('sources')).toBe(1)
    expect(countRows('processing_jobs')).toBe(1)

    // Re-ingest with the identical id/checksum (e.g. a webhook redelivery) — must dedupe, not crash.
    expect(() => insertSourceAndJob(db, args)).not.toThrow()
    expect(countRows('sources')).toBe(1)
    expect(countRows('processing_jobs')).toBe(1)
    expect(new SourcesRepo(db).get(sourceId)).toBeTruthy()
  })

  it('re-ingesting the SAME checksum under a DIFFERENT id is also deduped (no duplicate source/job)', () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'same-checksum' },
      job: { id: jobId, source_id: sourceId, next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })

    const dupSourceId = newId(), dupJobId = newId()
    expect(() => insertSourceAndJob(db, {
      source: { id: dupSourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'same-checksum' },
      job: { id: dupJobId, source_id: dupSourceId, next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })).not.toThrow()

    expect(countRows('sources')).toBe(1)
    expect(countRows('processing_jobs')).toBe(1)
    // The second (duplicate-checksum) source id was never created.
    expect(new SourcesRepo(db).get(dupSourceId)).toBeFalsy()
  })
})

describe('Processor.drainOnce', () => {
  let db: DB
  const clock = new FixedClock('2025-03-12T10:30:00Z')
  beforeEach(() => { db = openDb(); migrate(db) })

  function makeProcessor(canned: unknown = v1id) {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db),
      candidates: new ExtractedFieldCandidatesRepo(db), reviewVersions: new FieldReviewVersionsRepo(db),
      conflicts: new FieldConflictsRepo(db), items: new CollectionItemsRepo(db),
      drafts: new DraftsRepo(db), outbox: new OutboxRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: new MockLlmClient(canned), resolver: new CustomerResolver(new CustomerIdentityRepo(db)),
      clock, workerId: 'w1', formTypes: ['acord_125'],
    })
  }

  // The customer id is now assigned by the resolver (not carried on the job); read it back off the
  // resolved source.
  function resolvedCustomer(sourceId: string): string {
    return new SourcesRepo(db).get(sourceId)!.customer_id!
  }

  it('processes a durably-enqueued source into facts + a projected draft under the resolved customer', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('about $30,000; roughly 35 full-time guys')), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const n = await makeProcessor().drainOnce()
    expect(n).toBe(1)
    const cid = resolvedCustomer(sourceId)
    expect(new SourcesRepo(db).get(sourceId)!.status).toBe('resolved')
    const rev = new ExtractedFieldCandidatesRepo(db).byField(cid, 'annual_gross_revenue')
    expect(rev.length).toBeGreaterThan(0)
    const draft = new DraftsRepo(db).current(cid, 'acord_125')
    expect(draft).toBeTruthy()
    expect(JSON.parse(draft!.projected_json).annual_gross_revenue).toBe(2500000)
  })

  it('marks the job done so a second drain does nothing', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('renewal call')), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    await makeProcessor().drainOnce()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).toBe('done')
    expect(await makeProcessor().drainOnce()).toBe(0)
  })

  it('persistence + job completion are atomic: a lost lease at commit rolls back ALL persistence (customer, facts, collection-item registrations, AND the draft)', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('about $30,000; roughly 35 full-time guys')), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const proc = makeProcessor()
    // Simulate losing the lease exactly at commit (another worker reclaimed after our lease expired).
    ;((proc as any).d.lease as LeaseClaimer).complete = () => false // deliberate failure injection: force the fenced completion to report a lost lease
    const n = await proc.drainOnce()
    expect(n).toBe(0)
    // Because completion is INSIDE the persist transaction, its failure rolls EVERYTHING back:
    // no customer created by the resolver, no facts, no draft, no collection-item registration, and
    // the source is NOT flipped to 'resolved'. The collection-item + customer assertions are the
    // load-bearing ones: they prove the resolver's identity writes AND extractFacts' registry
    // writes (via resolveItemId for the fixture's `claims` collection) are inside the SAME
    // transaction as everything else, not committed independently before the fence.
    expect(db.prepare('SELECT COUNT(*) n FROM customers').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM extracted_field_candidates').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM form_drafts').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM collection_items').get()).toMatchObject({ n: 0 })
    expect(new SourcesRepo(db).get(sourceId)!.status).toBe('received')
    expect(new SourcesRepo(db).get(sourceId)!.customer_id).toBeNull()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).not.toBe('done')
  })

  it('cancels a still-pending fill when a later job reprojects the form with changed content (Task 15 window; re-review gate)', async () => {
    // T1 -> draft rev1 (revenue 2.5M) via the coastal_v1 fixture.
    const s1 = newId(), j1 = newId()
    insertSourceAndJob(db, {
      source: { id: s1, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('about $30,000; roughly 35 full-time guys')), checksum: 'k1' },
      job: { id: j1, source_id: s1, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    expect(await makeProcessor().drainOnce()).toBe(1)
    const cid = resolvedCustomer(s1)
    const drafts = new DraftsRepo(db), outbox = new OutboxRepo(db)
    const d1 = drafts.current(cid, 'acord_125')!
    expect(JSON.parse(d1.projected_json).annual_gross_revenue).toBe(2500000)

    // Stand in for an in-flight approved fill: approve the draft row and enqueue an outbox row for
    // its revision (what approveForm does at commit), then DON'T drain the fill worker.
    drafts.approve(d1.id, 'sarah', clock.now())
    const oid = outbox.enqueue(cid, 'acord_125', d1.revision, {}, 'pending-hash', clock.now())
    expect(outbox.get(oid)!.status).toBe('pending')

    // A correcting transcript (revenue 2.8M, a NEWER source) is processed BEFORE the fill drains.
    // It carries the SAME FEIN, so it resolves to the SAME customer. These revenue facts were never
    // approved, so the newer value wins selectCurrentCandidate and the projection changes; upsertProjection
    // rewrites the approved draft IN PLACE (same revision, reset to needs_review). The processor must
    // cancel the now-stale pending fill.
    const s2 = newId(), j2 = newId()
    insertSourceAndJob(db, {
      source: { id: s2, customer_id: null, type: 'call_transcript', source_date: '2025-03-15T10:00:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('revenue was actually 2.8 million')), checksum: 'k2' },
      job: { id: j2, source_id: s2, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const proc2 = new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db),
      candidates: new ExtractedFieldCandidatesRepo(db), reviewVersions: new FieldReviewVersionsRepo(db),
      conflicts: new FieldConflictsRepo(db), items: new CollectionItemsRepo(db),
      drafts: new DraftsRepo(db), outbox: new OutboxRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: new MockLlmClient(v2id), resolver: new CustomerResolver(new CustomerIdentityRepo(db)),
      clock, workerId: 'w2', formTypes: ['acord_125'],
    })
    expect(await proc2.drainOnce()).toBe(1)
    expect(resolvedCustomer(s2)).toBe(cid) // the correction resolved to the SAME customer via FEIN

    const d2 = drafts.current(cid, 'acord_125')!
    expect(d2.id).toBe(d1.id)                                                  // in-place reproject (same row)
    expect(d2.revision).toBe(d1.revision)
    expect(JSON.parse(d2.projected_json).annual_gross_revenue).toBe(2800000)   // content genuinely changed
    expect(d2.status).toBe('needs_review')
    expect(outbox.get(oid)!.status).toBe('cancelled')                          // the stale fill was cancelled
  })

  it('leaves an approved draft (and its in-flight fill) untouched when a reprocess yields identical facts', async () => {
    // T1 -> draft rev1 via coastal_v1.
    const s1 = newId(), j1 = newId()
    insertSourceAndJob(db, {
      source: { id: s1, customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('about $30,000; roughly 35 full-time guys')), checksum: 'k1' },
      job: { id: j1, source_id: s1, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    expect(await makeProcessor().drainOnce()).toBe(1)
    const cid = resolvedCustomer(s1)
    const drafts = new DraftsRepo(db), outbox = new OutboxRepo(db)

    // Approve the draft and enqueue an in-flight fill for its revision; don't drain the fill worker.
    const d1 = drafts.current(cid, 'acord_125')!
    drafts.approve(d1.id, 'sarah', clock.now())
    const approved = drafts.current(cid, 'acord_125')!
    const oid = outbox.enqueue(cid, 'acord_125', approved.revision, {}, 'pending-hash', clock.now())
    expect(outbox.get(oid)!.status).toBe('pending')

    // A redelivered transcript with the SAME content (newer source_date so the job is claimed and
    // facts are re-inserted) projects byte-identically. upsertProjection must short-circuit: the
    // approved draft is left as-is and its pending fill is NOT cancelled.
    const s2 = newId(), j2 = newId()
    insertSourceAndJob(db, {
      source: { id: s2, customer_id: null, type: 'call_transcript', source_date: '2025-03-15T10:00:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: rawJson(withFein('about $30,000; roughly 35 full-time guys')), checksum: 'k2' },
      job: { id: j2, source_id: s2, next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    expect(await makeProcessor().drainOnce()).toBe(1)
    expect(resolvedCustomer(s2)).toBe(cid)

    const d2 = drafts.current(cid, 'acord_125')!
    expect(d2.id).toBe(approved.id)                       // same row
    expect(d2.revision).toBe(approved.revision)           // no new revision
    expect(d2.status).toBe('approved')                    // NOT reset to needs_review
    expect(d2.approved_by).toBe('sarah')                  // approval preserved (an in-place update nulls this)
    expect(d2.approved_at).toBe(approved.approved_at)
    expect(d2.updated_at).toBe(approved.updated_at)       // untouched
    expect(outbox.get(oid)!.status).toBe('pending')       // in-flight fill NOT cancelled
  })
})
