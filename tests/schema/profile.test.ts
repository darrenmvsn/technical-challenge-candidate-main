import { describe, it, expect } from 'vitest'
import { ExtractionEnvelope } from '../../src/schema/profile.js'

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
})
