import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import { currentProfileMap } from '../../src/profile/currentProfile.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const candidate = (id: string, sourceDate: string, value: unknown): ExtractedFieldCandidate => ({
  id,
  customer_id: 'c1',
  field_path: 'annual_gross_revenue',
  value_json: JSON.stringify(value),
  presence: 'present',
  confidence: 0.9,
  evidence_quote: 'q',
  evidence_span_start: 0,
  evidence_span_end: 1,
  match_quality: 'exact',
  source_id: id,
  source_date: sourceDate,
  extracted_at: sourceDate,
  superseded_by: null,
})

describe('currentProfileMap', () => {
  let db: DB
  let candidates: ExtractedFieldCandidatesRepo
  let reviews: FieldReviewVersionsRepo

  beforeEach(() => {
    db = openDb()
    migrate(db)
    candidates = new ExtractedFieldCandidatesRepo(db)
    reviews = new FieldReviewVersionsRepo(db)
  })

  it('uses the latest review version over a newer machine candidate', () => {
    candidates.insertMany([
      candidate('cand-old', '2025-03-12T00:00:00Z', 2500000),
      candidate('cand-new', '2025-03-15T00:00:00Z', 2800000),
    ])
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand-old', valueJson: '2500000', presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z' })
    const current = currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!
    expect(current.value_json).toBe('2500000')
    expect(current.review_status).toBe('approved')
    expect(current.review!.candidate_id).toBe('cand-old')
    expect(current.selected_candidate.id).toBe('cand-new')
    expect(current.value_candidate.id).toBe('cand-old')
  })

  it('falls back to the selected machine candidate when no review exists', () => {
    candidates.insertMany([
      candidate('cand-old', '2025-03-12T00:00:00Z', 2500000),
      candidate('cand-new', '2025-03-15T00:00:00Z', 2800000),
    ])
    const current = currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!
    expect(current.value_json).toBe('2800000')
    expect(current.review_status).toBe('needs_review')
    expect(current.selected_candidate.id).toBe('cand-new')
    expect(current.value_candidate.id).toBe('cand-new')
  })
})
