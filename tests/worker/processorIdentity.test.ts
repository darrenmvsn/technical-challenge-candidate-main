import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { SourcesRepo, insertSourceAndJob } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { CustomerIdentityRepo } from '../../src/db/repos/customerIdentity.js'
import { CustomerResolver } from '../../src/identity/customerResolver.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MockLlmClient } from '../../src/extraction/llmClient.js'
import { Processor } from '../../src/worker/processor.js'
import { FixedClock } from '../../src/clock.js'

describe('Processor identity resolution', () => {
  let db: DB
  const clock = new FixedClock('2025-03-12T10:31:00Z')
  beforeEach(() => { db = openDb(); migrate(db) })

  function makeProcessor(canned: unknown) {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
      conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
      outbox: new OutboxRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: new MockLlmClient(canned), resolver: new CustomerResolver(new CustomerIdentityRepo(db)),
      clock, workerId: 'w1', formTypes: ['acord_125'],
    })
  }

  it('extracts identity, creates a customer, then persists facts under that customer', async () => {
    // The FEIN and revenue evidence quotes appear verbatim (and exactly once) in `content`, so the
    // resolver's anti-hallucination guard admits the hard FEIN signal and the fact evidence resolves.
    const transcript = 'The business is Coastal Roofing LLC. Our FEIN is 12-3456789. Last year revenue was about 2.5 million dollars.'
    insertSourceAndJob(db, {
      source: {
        id: 'src_001', customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z',
        raw_json: JSON.stringify({ id: 'src_001', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: transcript }),
        extraction_json: null, checksum: 'x', status: 'received',
      },
      job: { id: 'job_001', source_id: 'src_001', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const canned = {
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      annual_gross_revenue: { value: 2500000, presence: 'present', confidence: 0.6, evidence: 'about 2.5 million dollars' },
    }
    expect(await makeProcessor(canned).drainOnce()).toBe(1)
    const source = new SourcesRepo(db).get('src_001')!
    expect(source.customer_id).toBeTruthy()
    expect(source.status).toBe('resolved')
    expect(new FactsRepo(db).byField(source.customer_id!, 'annual_gross_revenue')).toHaveLength(1)
  })

  it('does not insert customer-scoped facts when identity is ambiguous', async () => {
    // Two existing customers each own a DISTINCT hard signal; a source carrying BOTH points at
    // two customers at once -> conflicting_identity_signals -> identity_needs_review, zero facts.
    const identity = new CustomerIdentityRepo(db)
    identity.createCustomerWithSignals({ legalName: 'A', signals: [{ type: 'fein', value: '123456789', sourceId: 'seedA' }], now: clock.now() })
    identity.createCustomerWithSignals({ legalName: 'B', signals: [{ type: 'email', value: 'other@x.com', sourceId: 'seedB' }], now: clock.now() })

    const transcript = 'FEIN 12-3456789 and email other@x.com are both on file; revenue was about 2.5 million dollars.'
    insertSourceAndJob(db, {
      source: {
        id: 'src_ambiguous', customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z',
        raw_json: JSON.stringify({ id: 'src_ambiguous', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: transcript }),
        extraction_json: null, checksum: 'y', status: 'received',
      },
      job: { id: 'job_ambiguous', source_id: 'src_ambiguous', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const canned = {
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      policyholder_email: { value: 'other@x.com', presence: 'present', confidence: 0.95, evidence: 'other@x.com' },
      annual_gross_revenue: { value: 2500000, presence: 'present', confidence: 0.6, evidence: 'about 2.5 million dollars' },
    }
    expect(await makeProcessor(canned).drainOnce()).toBe(1)
    expect(new SourcesRepo(db).get('src_ambiguous')!.status).toBe('identity_needs_review')
    expect(db.prepare('SELECT COUNT(*) n FROM facts').get()).toMatchObject({ n: 0 })
  })
})
