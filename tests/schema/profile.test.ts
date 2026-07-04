import { describe, it, expect } from 'vitest'
import { ExtractionEnvelope } from '../../src/schema/profile'

describe('ExtractionEnvelope', () => {
  it('accepts a present field with evidence', () => {
    const parsed = ExtractionEnvelope.parse({
      annual_gross_revenue: { value: 2500000, presence: 'present', confidence: 0.6, evidence: 'about two and a half million' },
    })
    expect(parsed.annual_gross_revenue?.value).toBe(2500000)
  })
  it('accepts a missing field with null value and null evidence', () => {
    const parsed = ExtractionEnvelope.parse({
      annual_gross_revenue: { value: null, presence: 'missing', confidence: 0, evidence: null },
    })
    expect(parsed.annual_gross_revenue?.presence).toBe('missing')
  })
  it('rejects an invalid presence', () => {
    expect(() => ExtractionEnvelope.parse({
      annual_gross_revenue: { value: 1, presence: 'unknown', confidence: 1, evidence: 'x' },
    })).toThrow()
  })
  it('rejects a present field with null evidence', () => {
    expect(() => ExtractionEnvelope.parse({
      annual_gross_revenue: { value: 5, presence: 'present', confidence: 1, evidence: null },
    })).toThrow()
  })
  it('rejects a missing field with non-null evidence', () => {
    expect(() => ExtractionEnvelope.parse({
      annual_gross_revenue: { value: null, presence: 'missing', confidence: 0, evidence: 'x' },
    })).toThrow()
  })
  it('accepts a needs_follow_up field with evidence', () => {
    const parsed = ExtractionEnvelope.parse({
      annual_gross_revenue: { value: null, presence: 'needs_follow_up', confidence: 0.2, evidence: 'they said maybe two million' },
    })
    expect(parsed.annual_gross_revenue?.presence).toBe('needs_follow_up')
  })
  it('accepts identity fields used by customer resolution', () => {
    const parsed = ExtractionEnvelope.parse({
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
      business_phone: { value: '910-555-0173', presence: 'present', confidence: 0.95, evidence: '910-555-0173' },
      policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
    })
    expect(parsed.business_name?.value).toBe('Coastal Roofing LLC')
    expect(parsed.policyholder_email?.value).toBe('mike.torres@coastalroofing.com')
  })

  // A present fein/email is a HARD identity signal we can auto-merge customers on and it also
  // reaches the ACORD form, so the raw candidate value must be format-checked at the boundary —
  // not only inside identity resolution. Malformed *present* values are rejected before persistence.
  it('accepts a present fein with exactly 9 digits (with or without punctuation)', () => {
    expect(ExtractionEnvelope.parse({
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    }).fein?.value).toBe('12-3456789')
    expect(ExtractionEnvelope.parse({
      fein: { value: '123456789', presence: 'present', confidence: 0.95, evidence: '123456789' },
    }).fein?.value).toBe('123456789')
  })
  it('rejects a present fein that is not 9 digits', () => {
    expect(() => ExtractionEnvelope.parse({
      fein: { value: 'not-a-fein', presence: 'present', confidence: 0.95, evidence: 'not-a-fein' },
    })).toThrow(/fein/)
    expect(() => ExtractionEnvelope.parse({
      fein: { value: '12-345', presence: 'present', confidence: 0.95, evidence: '12-345' },
    })).toThrow(/fein/)
    expect(() => ExtractionEnvelope.parse({
      fein: { value: '1234567890', presence: 'present', confidence: 0.95, evidence: '1234567890' },
    })).toThrow(/fein/)
  })
  // The value must be the identifier ITSELF, not a labeled/padded string — a digit-count check
  // would wrongly accept these (9 digits are present) and persist the raw string onto the form.
  it('rejects a present fein carrying label text or surrounding whitespace', () => {
    expect(() => ExtractionEnvelope.parse({
      fein: { value: 'FEIN 12-3456789', presence: 'present', confidence: 0.95, evidence: 'FEIN 12-3456789' },
    })).toThrow(/fein/)
    expect(() => ExtractionEnvelope.parse({
      fein: { value: ' 12-3456789', presence: 'present', confidence: 0.95, evidence: ' 12-3456789' },
    })).toThrow(/fein/)
    expect(() => ExtractionEnvelope.parse({
      fein: { value: 'EIN: 12 3456789', presence: 'present', confidence: 0.95, evidence: 'EIN: 12 3456789' },
    })).toThrow(/fein/)
  })
  it('rejects a present policyholder_email that is not email-shaped or is whitespace-padded', () => {
    expect(() => ExtractionEnvelope.parse({
      policyholder_email: { value: 'not-an-email', presence: 'present', confidence: 0.95, evidence: 'not-an-email' },
    })).toThrow(/email/)
    expect(() => ExtractionEnvelope.parse({
      policyholder_email: { value: 'mike@coastal', presence: 'present', confidence: 0.95, evidence: 'mike@coastal' },
    })).toThrow(/email/)
    expect(() => ExtractionEnvelope.parse({
      policyholder_email: { value: ' mike@coastalroofing.com ', presence: 'present', confidence: 0.95, evidence: ' mike@coastalroofing.com ' },
    })).toThrow(/email/)
  })
  // A 'present' field asserts a value was extracted, so a null value is contradictory and must be
  // rejected before it is persisted as a "present but empty" candidate that flows into review/fill.
  it("rejects any present field whose value is null", () => {
    expect(() => ExtractionEnvelope.parse({
      annual_gross_revenue: { value: null, presence: 'present', confidence: 0.9, evidence: 'about two and a half million' },
    })).toThrow(/value is required when presence is 'present'/)
    expect(() => ExtractionEnvelope.parse({
      fein: { value: null, presence: 'present', confidence: 0.9, evidence: 'let me pull up my FEIN' },
    })).toThrow(/value is required when presence is 'present'/)
  })
  it('does not format-check fein/email that are absent (missing / needs_follow_up)', () => {
    expect(ExtractionEnvelope.parse({
      fein: { value: null, presence: 'missing', confidence: 0, evidence: null },
      policyholder_email: { value: null, presence: 'needs_follow_up', confidence: 0.2, evidence: 'he will email it over' },
    }).fein?.presence).toBe('missing')
  })
})
