import { describe, it, expect } from 'vitest'
import { selectCurrentFact } from '../../src/profile/factSelector.js'
import type { Fact } from '../../src/schema/profile.js'

const base: Fact = {
  id: 'x', customer_id: 'c1', field_path: 'annual_gross_revenue', value_json: '1',
  presence: 'present', confidence: 0.5, evidence_quote: null, evidence_span_start: null,
  evidence_span_end: null, match_quality: 'none', source_id: 's', source_date: '2025-01-01T00:00:00Z',
  extracted_at: '2025-01-01T00:00:00Z', review_status: 'needs_review', reviewed_value_json: null,
  reviewed_by: null, reviewed_at: null, superseded_by: null,
}
const f = (o: Partial<Fact>): Fact => ({ ...base, ...o })

describe('selectCurrentFact', () => {
  it('prefers an approved fact over a newer machine one', () => {
    const approved = f({ id: 'a', review_status: 'approved', source_date: '2025-01-01T00:00:00Z' })
    const newerMachine = f({ id: 'b', review_status: 'needs_review', source_date: '2025-06-01T00:00:00Z' })
    expect(selectCurrentFact([newerMachine, approved])!.id).toBe('a')
  })

  it('among machine facts, newest source_date wins regardless of arrival', () => {
    const older = f({ id: 'o', source_date: '2025-01-01T00:00:00Z', extracted_at: '2025-09-01T00:00:00Z' })
    const newer = f({ id: 'n', source_date: '2025-03-01T00:00:00Z', extracted_at: '2025-02-01T00:00:00Z' })
    expect(selectCurrentFact([older, newer])!.id).toBe('n')
  })

  it('breaks source_date ties by confidence', () => {
    const lo = f({ id: 'lo', confidence: 0.3 })
    const hi = f({ id: 'hi', confidence: 0.9 })
    expect(selectCurrentFact([lo, hi])!.id).toBe('hi')
  })

  it('breaks confidence ties by latest extracted_at', () => {
    const early = f({ id: 'early', extracted_at: '2025-01-01T00:00:00Z' })
    const late = f({ id: 'late', extracted_at: '2025-06-01T00:00:00Z' })
    expect(selectCurrentFact([early, late])!.id).toBe('late')
  })

  it('ignores superseded rows', () => {
    const dead = f({ id: 'd', review_status: 'approved', superseded_by: 'z' })
    const live = f({ id: 'l' })
    expect(selectCurrentFact([dead, live])!.id).toBe('l')
  })

  it('returns undefined for no candidates', () => {
    expect(selectCurrentFact([])).toBeUndefined()
  })

  it('returns undefined when every candidate is superseded', () => {
    const a = f({ id: 'a', superseded_by: 'z1' })
    const b = f({ id: 'b', review_status: 'approved', superseded_by: 'z2' })
    expect(selectCurrentFact([a, b])).toBeUndefined()
  })

  // --- Hard cases motivating invariant #7 -----------------------------------
  // A human correction must win over a machine-extracted fact with higher
  // confidence and/or a fresher extracted_at, no matter which row was
  // inserted first / stored at a lower id / appears earlier in the array.
  // These tests exercise every permutation of insertion order to prove the
  // winner is selected by the precedence rule alone, never by array position.

  it('HARD CASE: a lower-confidence approved correction beats a higher-confidence unapproved fact in every insertion order', () => {
    // Inserted BEFORE the higher-confidence fact, but that must not matter.
    const approvedLowConf = f({
      id: 'winner-approved', review_status: 'approved', confidence: 0.2,
      source_date: '2024-01-01T00:00:00Z', extracted_at: '2024-01-01T00:00:00Z',
    })
    // Higher confidence, later source_date, later extracted_at, higher id
    // sort order — every non-approval signal favors this row, and it still
    // must lose because approval outranks all of them.
    const hiConfDecoy = f({
      id: 'z-decoy-hi-conf', review_status: 'needs_review', confidence: 0.99,
      source_date: '2025-06-01T00:00:00Z', extracted_at: '2025-06-01T00:00:00Z',
    })

    const orderings: Fact[][] = [
      [approvedLowConf, hiConfDecoy],
      [hiConfDecoy, approvedLowConf],
    ]
    for (const order of orderings) {
      expect(selectCurrentFact(order)!.id).toBe('winner-approved')
    }
  })

  it('HARD CASE: a lower-confidence correction with a newer source_date beats a higher-confidence earlier fact in every insertion order', () => {
    const newerSourceDateLowConf = f({
      id: 'winner-newer-source', review_status: 'needs_review', confidence: 0.1,
      source_date: '2025-06-01T00:00:00Z', extracted_at: '2024-01-01T00:00:00Z',
    })
    const olderSourceDateHiConfDecoy = f({
      id: 'z-decoy-hi-conf-early', review_status: 'needs_review', confidence: 0.99,
      source_date: '2024-01-01T00:00:00Z', extracted_at: '2025-06-01T00:00:00Z',
    })
    const thirdDecoy = f({
      id: 'y-decoy-approved-but-older-still-loses-to-approval', review_status: 'needs_review',
      confidence: 0.5, source_date: '2025-01-01T00:00:00Z', extracted_at: '2025-01-01T00:00:00Z',
    })

    const orderings: Fact[][] = [
      [newerSourceDateLowConf, olderSourceDateHiConfDecoy, thirdDecoy],
      [olderSourceDateHiConfDecoy, newerSourceDateLowConf, thirdDecoy],
      [thirdDecoy, olderSourceDateHiConfDecoy, newerSourceDateLowConf],
      [olderSourceDateHiConfDecoy, thirdDecoy, newerSourceDateLowConf],
    ]
    for (const order of orderings) {
      expect(selectCurrentFact(order)!.id).toBe('winner-newer-source')
    }
  })

  it('documented final tiebreak: when approval/source_date/confidence/extracted_at all tie, the first candidate in the given array wins (stable sort), not any id/position rule', () => {
    const first = f({ id: 'first-in-array' })
    const second = f({ id: 'second-in-array' })
    // All four precedence fields are identical (inherited from `base`).
    expect(selectCurrentFact([first, second])!.id).toBe('first-in-array')
    expect(selectCurrentFact([second, first])!.id).toBe('second-in-array')
  })
})
