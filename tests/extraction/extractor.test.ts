import { describe, it, expect, beforeEach } from 'vitest'
import fixture from '../fixtures/llm/coastal_v1.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { extractFacts } from '../../src/extraction/extractor.js'
import { ExtractionEnvelope } from '../../src/schema/profile.js'
import { FixedClock } from '../../src/clock.js'

describe('extractFacts', () => {
  let db: DB, itemsRepo: CollectionItemsRepo
  const clock = new FixedClock('2025-03-12T10:30:00Z')
  const transcript = "My name's Mike Torres. about two and a half million, maybe a little over. roughly 35 full-time guys. about $30,000."
  beforeEach(() => { db = openDb(); migrate(db); itemsRepo = new CollectionItemsRepo(db) })

  it('produces a scalar fact with a resolved evidence span', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const rev = facts.find(f => f.field_path === 'annual_gross_revenue')!
    expect(rev.value_json).toBe('2500000')
    expect(rev.presence).toBe('present')
    expect(rev.evidence_span_start).not.toBeNull()
    expect(rev.evidence_span_end).not.toBeNull()
    expect(rev.match_quality).not.toBe('none')
  })

  it('keys collection-item facts by resolved item_id, not array index', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const amount = facts.find(f => f.field_path.startsWith('claims.') && f.field_path.endsWith('.amount'))!
    expect(amount.field_path).toMatch(/^claims\.[a-f0-9]{24}\.amount$/)
    expect(amount.value_json).toBe('30000')
  })

  it('forces needs_review when a present value has an unlocatable quote', () => {
    const env = ExtractionEnvelope.parse({
      fein: { value: '99-9999999', presence: 'present', confidence: 0.9, evidence: 'not in the transcript at all' },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const fein = facts.find(f => f.field_path === 'fein')!
    expect(fein.match_quality).toBe('none')
    expect(fein.review_status).toBe('needs_review')
  })

  it('flattens a fixed nested object into leaf facts matching the form bindings', () => {
    const env = ExtractionEnvelope.parse({
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript: 'PO Box 9102, Wilmington, NC 28402', clock, itemsRepo })
    expect(facts.find(f => f.field_path === 'mailing_address.street')!.value_json).toBe('"PO Box 9102"')
    expect(facts.find(f => f.field_path === 'mailing_address.zip')!.value_json).toBe('"28402"')
    expect(facts.find(f => f.field_path === 'mailing_address')).toBeUndefined() // no whole-object fact
  })

  it('uses a deterministic id so reprocessing the same source does not fork facts', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const a = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const b = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const idOf = (fs: typeof a, p: string) => fs.find(f => f.field_path === p)!.id
    expect(idOf(a, 'annual_gross_revenue')).toBe(idOf(b, 'annual_gross_revenue'))
  })

  it('emits an explicit missing fact (null evidence) for a scalar field the LLM marked missing', () => {
    const env = ExtractionEnvelope.parse({
      dba_name: { value: null, presence: 'missing', confidence: 0, evidence: null },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const dba = facts.find(f => f.field_path === 'dba_name')!
    expect(dba.presence).toBe('missing')
    expect(dba.value_json).toBeNull()
    expect(dba.evidence_quote).toBeNull()
    expect(dba.evidence_span_start).toBeNull()
    expect(dba.evidence_span_end).toBeNull()
  })

  it('emits no fact at all for a nested-object field the LLM marked missing (no leaves to decompose from null; reconciler materializes each bound leaf as missing)', () => {
    const env = ExtractionEnvelope.parse({
      mailing_address: { value: null, presence: 'missing', confidence: 0, evidence: null },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    expect(facts.filter(f => f.field_path === 'mailing_address' || f.field_path.startsWith('mailing_address.'))).toHaveLength(0)
  })

  it('stamps extracted_at from the injected Clock, never the wall clock', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    for (const f of facts) expect(f.extracted_at).toBe('2025-03-12T10:30:00Z')
  })
})
