import { describe, it, expect, beforeEach } from 'vitest'
import fixture from '../fixtures/llm/coastal_v1.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { SourcesRepo, type SourceRow } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { CustomerIdentityRepo } from '../../src/db/repos/customerIdentity.js'
import { CustomerResolver } from '../../src/identity/customerResolver.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import type { LlmClient } from '../../src/extraction/llmClient.js'
import { Processor } from '../../src/worker/processor.js'
import { FixedClock } from '../../src/clock.js'
import { IdentityReviewClient } from '../../src/review/identityReviewClient.js'

describe('IdentityReviewClient', () => {
  let db: DB
  let identity: CustomerIdentityRepo
  let client: IdentityReviewClient
  const clock = new FixedClock('2025-03-12T10:31:00Z')

  beforeEach(() => {
    db = openDb()
    migrate(db)
    identity = new CustomerIdentityRepo(db)
    client = new IdentityReviewClient({
      sources: new SourcesRepo(db),
      jobs: new ProcessingJobsRepo(db),
      identity,
      clock,
    })
  })

  function seedCustomer(): string {
    return identity.createCustomer({ legalName: 'Seed Co', dba: null, owner: null, now: clock.now() })
  }

  function seedSource(row: {
    id: string
    status: SourceRow['status']
    customer_id: string | null
    raw_json: string
    extraction_json: string
  }): void {
    new SourcesRepo(db).insert({
      id: row.id,
      customer_id: row.customer_id,
      type: 'call_transcript',
      source_date: '2025-03-12T10:30:00Z',
      received_at: '2025-03-12T10:31:00Z',
      raw_json: row.raw_json,
      extraction_json: row.extraction_json,
      checksum: row.id,
      status: row.status,
    })
  }

  /** Proves the reused extraction is used: any real call to `extract` fails the test. */
  function makeProcessorWithThrowingLlm(): Processor {
    const throwingLlm: LlmClient = {
      extract: async () => { throw new Error('LLM must not be called when extraction_json is already stored') },
    }
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
      conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
      outbox: new OutboxRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: throwingLlm, resolver: new CustomerResolver(identity),
      clock, workerId: 'w1', formTypes: ['acord_125'],
    })
  }

  it('lets a reviewer attach an ambiguous source to an existing customer and requeue it', () => {
    const customerId = seedCustomer()
    seedSource({
      id: 'src_ambiguous',
      status: 'identity_needs_review',
      customer_id: null,
      raw_json: JSON.stringify({ id: 'src_ambiguous', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: 'reviewed manually' }),
      extraction_json: JSON.stringify(fixture),
    })
    const result = client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' })
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('unreachable')
    expect(new ProcessingJobsRepo(db).get(result.jobId)!.status).toBe('pending')
    expect(new SourcesRepo(db).get('src_ambiguous')!.customer_id).toBe(customerId)
  })

  it('stores verified identity signals when a reviewer attaches a source', () => {
    const customerId = seedCustomer()
    seedSource({
      id: 'src_ambiguous',
      status: 'identity_needs_review',
      customer_id: null,
      raw_json: JSON.stringify({
        id: 'src_ambiguous',
        type: 'call_transcript',
        date: '2025-03-12T10:30:00Z',
        participants: ['Sarah Chen (Agent)', 'Mike Torres'],
        content: 'Coastal Roofing LLC\n12-3456789\nmike.torres@coastalroofing.com',
      }),
      extraction_json: JSON.stringify({
        fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
        policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
        business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      }),
    })
    expect(client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' }).status).toBe('resolved')
    expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([customerId])
    expect(identity.findCustomersBySignal('email', 'mike.torres@coastalroofing.com')).toEqual([customerId])
  })

  it('does not attach or requeue when manual attach conflicts with an existing hard signal', () => {
    const existingCustomerId = identity.createCustomerWithSignals({
      legalName: 'Existing Business',
      signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed' }],
      now: clock.now(),
    })
    const chosenCustomerId = seedCustomer()
    seedSource({
      id: 'src_conflict',
      status: 'identity_needs_review',
      customer_id: null,
      raw_json: JSON.stringify({
        id: 'src_conflict',
        type: 'call_transcript',
        date: '2025-03-12T10:30:00Z',
        participants: ['Sarah Chen (Agent)', 'Mike Torres'],
        content: '12-3456789',
      }),
      extraction_json: JSON.stringify({
        fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      }),
    })
    const result = client.resolveSourceToCustomer('src_conflict', chosenCustomerId, { by: 'sarah' })
    expect(result).toMatchObject({ status: 'needs_review', reason: 'hard_identity_signal_conflict' })
    expect(new SourcesRepo(db).get('src_conflict')!.customer_id).toBeNull()
    expect(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE source_id='src_conflict' AND status='pending'").get()).toMatchObject({ n: 0 })
    expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([existingCustomerId])
  })

  it('processes a reviewer-attached source under the chosen customer instead of looping to identity review', async () => {
    const customerId = seedCustomer()
    seedSource({
      id: 'src_ambiguous',
      status: 'identity_needs_review',
      customer_id: null,
      raw_json: JSON.stringify({ id: 'src_ambiguous', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: 'reviewed manually' }),
      extraction_json: JSON.stringify(fixture),
    })
    client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' })
    expect(await makeProcessorWithThrowingLlm().drainOnce()).toBe(1) // extraction_json is reused; no second LLM call
    const source = new SourcesRepo(db).get('src_ambiguous')!
    expect(source.status).toBe('resolved')
    expect(source.customer_id).toBe(customerId)
    expect(new FactsRepo(db).byField(customerId, 'annual_gross_revenue').length).toBeGreaterThan(0)
  })
})
