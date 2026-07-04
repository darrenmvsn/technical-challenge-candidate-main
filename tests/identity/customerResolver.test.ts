import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { CustomerIdentityRepo } from '../../src/db/repos/customerIdentity.js'
import { CustomerResolver } from '../../src/identity/customerResolver.js'
import { FixedClock } from '../../src/clock.js'
import { ExtractionEnvelope } from '../../src/schema/profile.js'

describe('CustomerResolver', () => {
  let db: DB, identity: CustomerIdentityRepo, resolver: CustomerResolver
  const clock = new FixedClock('2025-03-12T10:31:00Z')

  beforeEach(() => {
    db = openDb()
    migrate(db)
    identity = new CustomerIdentityRepo(db)
    resolver = new CustomerResolver(identity)
  })

  const transcript = [
    'Coastal Roofing LLC',
    'okay, it is 12-3456789',
    'mike.torres@coastalroofing.com',
    'my cell is 910-555-0173',
    'PO Box 9102, Wilmington, NC 28402',
  ].join('\n')

  it('creates a new customer when hard identity signals have no existing match', () => {
    const env = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_001', now: clock.now(), transcript })
    expect(result.status).toBe('resolved')
    expect(result.customerId).toBeTruthy()
    expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([result.customerId])
  })

  it('resolves to an existing customer by FEIN', () => {
    const customerId = identity.createCustomerWithSignals({
      legalName: 'Coastal Roofing LLC',
      signals: [{ type: 'fein', value: '123456789', sourceId: 'seed' }],
      now: clock.now(),
    })
    const env = ExtractionEnvelope.parse({
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_002', now: clock.now(), transcript })
    expect(result).toMatchObject({ status: 'resolved', customerId })
  })

  it('returns needs_review when hard signals point to different customers', () => {
    identity.createCustomerWithSignals({ legalName: 'A', signals: [{ type: 'fein', value: '123456789', sourceId: 'seed1' }], now: clock.now() })
    identity.createCustomerWithSignals({ legalName: 'B', signals: [{ type: 'email', value: 'mike@x.com', sourceId: 'seed2' }], now: clock.now() })
    const env = ExtractionEnvelope.parse({
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      policyholder_email: { value: 'mike@x.com', presence: 'present', confidence: 0.95, evidence: 'mike@x.com' },
    })
    const conflictTranscript = '12-3456789\nmike@x.com'
    expect(resolver.resolve(env, { sourceId: 'src_003', now: clock.now(), transcript: conflictTranscript }).status).toBe('needs_review')
  })

  it('does not use a hallucinated identifier whose evidence is not in the transcript', () => {
    const env = ExtractionEnvelope.parse({
      fein: { value: '98-7654321', presence: 'present', confidence: 0.99, evidence: '98-7654321' },
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_004', now: clock.now(), transcript: 'Coastal Roofing LLC only' })
    expect(result.status).toBe('needs_review')
    expect(identity.findCustomersBySignal('fein', '987654321')).toEqual([])
  })

  it('does not ground a hard signal whose VALUE is absent from the transcript even when its evidence quote is present', () => {
    // Value/evidence decoupling: the evidence quote ('Coastal Roofing LLC') is a real transcript
    // phrase, but the FEIN digits ('98-7654321') appear nowhere in the transcript. A fabricated
    // value carrying a real-but-unrelated quote must NOT ground a hard signal — otherwise it could
    // silently auto-resolve/auto-create a customer off a hallucinated identifier (invariant #13).
    const existing = identity.createCustomerWithSignals({ legalName: 'Existing', signals: [{ type: 'fein', value: '987654321', sourceId: 'seed' }], now: clock.now() })
    const env = ExtractionEnvelope.parse({
      fein: { value: '98-7654321', presence: 'present', confidence: 0.99, evidence: 'Coastal Roofing LLC' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_decoupled', now: clock.now(), transcript })
    // Must NOT silently merge this source into the pre-existing customer that owns 987654321.
    expect(result.status).toBe('needs_review')
    expect(result.customerId).toBeUndefined()
    expect(identity.findCustomersBySignal('fein', '987654321')).toEqual([existing])
  })

  it('does not auto-resolve or auto-create from business name/address alone', () => {
    const env = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_005', now: clock.now(), transcript })
    expect(result.status).toBe('needs_review')
  })

  it('does not auto-create when a new hard signal has an exact supporting match to an existing customer', () => {
    identity.createCustomerWithSignals({
      legalName: 'Coastal Roofing LLC',
      signals: [{ type: 'business_name_state', value: 'coastal roofing llc|nc', sourceId: 'seed' }],
      now: clock.now(),
    })
    const env = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      fein: { value: '98-7654321', presence: 'present', confidence: 0.95, evidence: '98-7654321' },
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_006', now: clock.now(), transcript: transcript.replace('12-3456789', '98-7654321') })
    expect(result.status).toBe('needs_review')
  })

  it('returns needs_review when hard and supporting signals match different customers', () => {
    identity.createCustomerWithSignals({ legalName: 'A', signals: [{ type: 'fein', value: '123456789', sourceId: 'seed1' }], now: clock.now() })
    identity.createCustomerWithSignals({ legalName: 'B', signals: [{ type: 'business_name_state', value: 'coastal roofing llc|nc', sourceId: 'seed2' }], now: clock.now() })
    const env = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_007', now: clock.now(), transcript })
    expect(result.status).toBe('needs_review')
  })

  it('does not treat a fuzzy business-name match as the same customer', () => {
    identity.createCustomerWithSignals({
      legalName: 'Coastal Roof LLC',
      signals: [{ type: 'business_name_state', value: 'coastal roof llc|nc', sourceId: 'seed' }],
      now: clock.now(),
    })
    const env = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const result = resolver.resolve(env, { sourceId: 'src_008', now: clock.now(), transcript })
    expect(result.status).toBe('needs_review')
  })

  it('does not allow the same hard signal to belong to two customers silently', () => {
    identity.createCustomerWithSignals({
      legalName: 'A',
      signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed1' }],
      now: clock.now(),
    })
    expect(() => identity.createCustomerWithSignals({
      legalName: 'B',
      signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed2' }],
      now: clock.now(),
    })).toThrow()
  })
})
