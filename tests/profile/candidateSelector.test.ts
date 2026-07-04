import { describe, it, expect } from 'vitest'
import { selectCurrentCandidate } from '../../src/profile/candidateSelector.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const base: ExtractedFieldCandidate = {
  id: 'x',
  customer_id: 'c1',
  field_path: 'annual_gross_revenue',
  value_json: '1',
  presence: 'present',
  confidence: 0.5,
  evidence_quote: null,
  evidence_span_start: null,
  evidence_span_end: null,
  match_quality: 'none',
  source_id: 's',
  source_date: '2025-01-01T00:00:00Z',
  extracted_at: '2025-01-01T00:00:00Z',
  superseded_by: null,
}
const c = (o: Partial<ExtractedFieldCandidate>): ExtractedFieldCandidate => ({ ...base, ...o })

describe('selectCurrentCandidate', () => {
  it('selects newest source_date before confidence', () => {
    const olderHighConfidence = c({ id: 'old', source_date: '2025-01-01T00:00:00Z', confidence: 0.99 })
    const newerLowConfidence = c({ id: 'new', source_date: '2025-02-01T00:00:00Z', confidence: 0.2 })
    expect(selectCurrentCandidate([olderHighConfidence, newerLowConfidence])!.id).toBe('new')
  })

  it('breaks source_date ties by confidence then extracted_at', () => {
    const a = c({ id: 'a', confidence: 0.8, extracted_at: '2025-01-01T00:00:00Z' })
    const b = c({ id: 'b', confidence: 0.8, extracted_at: '2025-01-02T00:00:00Z' })
    expect(selectCurrentCandidate([a, b])!.id).toBe('b')
  })

  it('ignores superseded candidates', () => {
    const dead = c({ id: 'dead', source_date: '2025-03-01T00:00:00Z', superseded_by: 'replacement' })
    const live = c({ id: 'live', source_date: '2025-01-01T00:00:00Z' })
    expect(selectCurrentCandidate([dead, live])!.id).toBe('live')
  })
})
