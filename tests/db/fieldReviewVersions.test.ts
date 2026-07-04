import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const candidate = (id: string, value: unknown): ExtractedFieldCandidate => ({
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
  source_date: '2025-03-12T00:00:00Z',
  extracted_at: '2025-03-12T00:00:00Z',
  superseded_by: null,
})

describe('FieldReviewVersionsRepo', () => {
  let db: DB
  let candidates: ExtractedFieldCandidatesRepo
  let reviews: FieldReviewVersionsRepo

  beforeEach(() => {
    db = openDb()
    migrate(db)
    candidates = new ExtractedFieldCandidatesRepo(db)
    reviews = new FieldReviewVersionsRepo(db)
    candidates.insertMany([candidate('cand1', 2500000), candidate('cand2', 2800000)])
  })

  it('inserts monotonically increasing versions per customer and field', () => {
    const v1 = reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'cand1',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })
    const v2 = reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'cand2',
      valueJson: '2800000',
      presence: 'present',
      action: 'accepted_conflict',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-17T00:00:00Z',
    })
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(reviews.latestByField('c1', 'annual_gross_revenue')!.id).toBe(v2.id)
  })

  it('latestMap returns only the active review version per field', () => {
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand1', valueJson: '2500000', presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z' })
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand2', valueJson: '2800000', presence: 'present', action: 'edited', reviewedBy: 'sarah', reviewedAt: '2025-03-17T00:00:00Z' })
    expect(reviews.latestMap('c1').get('annual_gross_revenue')!.value_json).toBe('2800000')
  })

  it('rejects a review version whose candidate does not belong to the same customer and field', () => {
    expect(() => reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'missing-candidate',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })).toThrow(/candidate/)
    expect(() => reviews.insertVersion({
      customerId: 'c2',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'cand1',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })).toThrow(/candidate/)
    expect(() => reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'employee_count_full_time',
      candidateId: 'cand1',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })).toThrow(/candidate/)
  })
})
