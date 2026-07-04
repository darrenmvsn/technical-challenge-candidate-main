import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, type DB } from '../../src/db/sqlite'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions'
import type { ExtractedFieldCandidate } from '../../src/schema/profile'

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

  // The version race: two overlapping approvals both read MAX(version) and then collide on
  // UNIQUE(customer_id, field_path, version). `insertVersion` computes MAX+1 INSIDE the INSERT so
  // the read and the write are one atomic write statement — the stale-read window is closed.
  //
  // better-sqlite3 is synchronous, so this cannot be truly concurrent; instead it uses two on-disk
  // connections to reproduce the exact interleaving deterministically: a stale two-statement write
  // duplicates a version (the bug), while the repo's atomic write lands on the next free version.
  describe('version assignment is atomic against a competing writer (two connections)', () => {
    let dir: string
    let dbA: DB
    let dbB: DB
    let reviewsA: FieldReviewVersionsRepo
    let reviewsB: FieldReviewVersionsRepo

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'review-versions-'))
      const filePath = join(dir, 'reviews.sqlite')
      dbA = openDb(filePath)
      migrate(dbA)
      new ExtractedFieldCandidatesRepo(dbA).insertMany([candidate('cand1', 2500000), candidate('cand2', 2800000)])
      dbB = openDb(filePath)
      reviewsA = new FieldReviewVersionsRepo(dbA)
      reviewsB = new FieldReviewVersionsRepo(dbB)
    })

    afterEach(() => {
      dbA.close()
      dbB.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('computes MAX(version)+1 inside the INSERT so an interleaved competing write cannot duplicate a version', () => {
      // 1. Connection A reads the "next" version the naive two-statement way (MAX+1 in a SELECT).
      const stale = dbA.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 n FROM field_review_versions WHERE customer_id=? AND field_path=?'
      ).get('c1', 'annual_gross_revenue') as { n: number }
      expect(stale.n).toBe(1)

      // 2. Connection B commits version 1 before A writes.
      const committed = reviewsB.insertVersion({
        customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand1', valueJson: '2500000',
        presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z',
      })
      expect(committed.version).toBe(1)

      // 3. A's stale two-statement INSERT reuses version 1 -> UNIQUE violation. This is the bug the
      //    atomic INSERT prevents by never separating the MAX read from the write.
      expect(() => dbA.prepare(`INSERT INTO field_review_versions
        (id, customer_id, field_path, version, candidate_id, value_json, presence, action, reviewed_by, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'stale-id', 'c1', 'annual_gross_revenue', stale.n, 'cand2', '2800000', 'present', 'edited', 'sarah', '2025-03-17T00:00:00Z'
      )).toThrow(/UNIQUE/)

      // 4. The repo computes the next version atomically from the now-committed state -> version 2.
      const next = reviewsA.insertVersion({
        customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand2', valueJson: '2800000',
        presence: 'present', action: 'accepted_conflict', reviewedBy: 'sarah', reviewedAt: '2025-03-17T00:00:00Z',
      })
      expect(next.version).toBe(2)
      expect(reviewsA.latestByField('c1', 'annual_gross_revenue')!.version).toBe(2)
    })
  })
})
