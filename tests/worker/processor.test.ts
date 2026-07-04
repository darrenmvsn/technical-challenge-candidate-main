import { describe, it, expect, beforeEach } from 'vitest'
import fixture from '../fixtures/llm/coastal_v1.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { SourcesRepo, insertSourceAndJob } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MockLlmClient } from '../../src/extraction/llmClient.js'
import { Processor } from '../../src/worker/processor.js'
import { FixedClock } from '../../src/clock.js'
import { newId } from '../../src/util/id.js'

describe('insertSourceAndJob (durable ingest)', () => {
  let db: DB
  beforeEach(() => { db = openDb(); migrate(db) })

  function countRows(table: 'sources' | 'processing_jobs'): number {
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
  }

  it('writes source + job atomically and re-ingesting the SAME id is a deduped no-op (no crash, no dup rows)', () => {
    const sourceId = newId(), jobId = newId()
    const args = {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'abc' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
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
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'same-checksum' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })

    const dupSourceId = newId(), dupJobId = newId()
    expect(() => insertSourceAndJob(db, {
      source: { id: dupSourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'same-checksum' },
      job: { id: dupJobId, source_id: dupSourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
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

  function makeProcessor() {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db),
      facts: new FactsRepo(db), conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db),
      drafts: new DraftsRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: new MockLlmClient(fixture), clock, workerId: 'w1', formTypes: ['acord_125'],
    })
  }

  it('processes a durably-enqueued source into facts + a projected draft', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'about $30,000; roughly 35 full-time guys' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const n = await makeProcessor().drainOnce()
    expect(n).toBe(1)
    const rev = new FactsRepo(db).byField('c1', 'annual_gross_revenue')
    expect(rev.length).toBeGreaterThan(0)
    const draft = new DraftsRepo(db).current('c1', 'acord_125')
    expect(draft).toBeTruthy()
    expect(JSON.parse(draft!.projected_json).annual_gross_revenue).toBe(2500000)
  })

  it('marks the job done so a second drain does nothing', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    await makeProcessor().drainOnce()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).toBe('done')
    expect(await makeProcessor().drainOnce()).toBe(0)
  })

  it('persistence + job completion are atomic: a lost lease at commit rolls back ALL persistence (facts, collection-item registrations, AND the draft)', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'about $30,000; roughly 35 full-time guys' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:30:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const proc = makeProcessor()
    // Simulate losing the lease exactly at commit (another worker reclaimed after our lease expired).
    ;((proc as any).d.lease as LeaseClaimer).complete = () => false // deliberate failure injection: force the fenced completion to report a lost lease
    const n = await proc.drainOnce()
    expect(n).toBe(0)
    // Because completion is INSIDE the persist transaction, its failure rolls everything back:
    // no facts, no draft, no collection-item registration, and the job is NOT marked done
    // (it stays reclaimable). The collection-item assertion is the load-bearing one: it proves
    // extractFacts' own registry writes (via CollectionItemsRepo.insert, invoked through
    // resolveItemId for the fixture's `claims` collection) are inside the SAME transaction as
    // everything else, not committed independently before the fence.
    expect(new FactsRepo(db).byField('c1', 'annual_gross_revenue').length).toBe(0)
    expect(new DraftsRepo(db).current('c1', 'acord_125')).toBeFalsy()
    expect(new CollectionItemsRepo(db).findId('c1', 'claims', '2023|workers_comp')).toBeUndefined()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).not.toBe('done')
  })
})
