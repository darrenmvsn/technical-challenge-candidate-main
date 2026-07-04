import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import { FieldConflictsRepo } from '../../src/db/repos/fieldConflicts.js'
import { reconcile } from '../../src/profile/reconciler.js'
import { selectCurrentCandidate } from '../../src/profile/candidateSelector.js'
import { currentProfileMap } from '../../src/profile/currentProfile.js'
import { boundScalarPaths } from '../../src/forms/renderers.js'
import { FixedClock } from '../../src/clock.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

function candidate(o: Partial<ExtractedFieldCandidate> & { id: string }): ExtractedFieldCandidate {
  return {
    customer_id: 'c1', field_path: 'annual_gross_revenue',
    value_json: '2500000', presence: 'present', confidence: 0.5, evidence_quote: null,
    evidence_span_start: null, evidence_span_end: null, match_quality: 'exact', source_id: o.id,
    source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    superseded_by: null, ...o,
  }
}

describe('reconcile', () => {
  let db: DB
  let candidates: ExtractedFieldCandidatesRepo
  let reviews: FieldReviewVersionsRepo
  let conflicts: FieldConflictsRepo
  const clock = new FixedClock('2025-03-16T00:00:00Z')

  beforeEach(() => {
    db = openDb()
    migrate(db)
    candidates = new ExtractedFieldCandidatesRepo(db)
    reviews = new FieldReviewVersionsRepo(db)
    conflicts = new FieldConflictsRepo(db)
  })

  it('opens a field conflict when a newer candidate disagrees with the latest review version', () => {
    candidates.insertMany([
      candidate({ id: 'old', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      candidate({ id: 'new', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'old',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })

    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })

    const open = conflicts.listUnresolved('c1')
    expect(open).toHaveLength(1)
    expect(open[0]!.current_candidate_id).toBe('old')
    expect(open[0]!.conflicting_candidate_id).toBe('new')
  })

  it('does not open a conflict when no human review version exists', () => {
    candidates.insertMany([
      candidate({ id: 'old', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      candidate({ id: 'new', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(conflicts.listUnresolved('c1')).toHaveLength(0)
    expect(currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!.value_json).toBe('2800000')
  })

  it('does not duplicate an unresolved conflict when reconcile runs twice for the same candidate', () => {
    candidates.insertMany([
      candidate({ id: 'old', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      candidate({ id: 'new', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'old',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(conflicts.listUnresolved('c1')).toHaveLength(1)
  })

  it('is all-or-nothing: a mid-batch failure rolls back every conflict write from that call (AGENTS.md #5/#12)', () => {
    // Two independently-disagreeing fields in one reconcile() call, each with an approved
    // review version and a newer disagreeing candidate, so the conflict-detection loop
    // attempts two conflict inserts in a single invocation.
    candidates.insertMany([
      candidate({ id: 'a1', field_path: 'annual_gross_revenue', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      candidate({ id: 'b1', field_path: 'annual_gross_revenue', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
      candidate({ id: 'a2', field_path: 'employee_count_full_time', value_json: '5', source_date: '2025-03-12T00:00:00Z' }),
      candidate({ id: 'b2', field_path: 'employee_count_full_time', value_json: '8', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reviews.insertVersion({
      customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'a1', valueJson: '2500000',
      presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z',
    })
    reviews.insertVersion({
      customerId: 'c1', fieldPath: 'employee_count_full_time', candidateId: 'a2', valueJson: '5',
      presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z',
    })

    // Deliberate failure injection to prove atomicity (AGENTS.md #1 permits `any`-free
    // monkeypatching for this): shadow the instance method with a spy that throws on the
    // 2nd conflict write. `insert` is a plain (non-readonly) method, so this needs no cast.
    let calls = 0
    const realInsert = conflicts.insert.bind(conflicts)
    conflicts.insert = (customerId, fieldPath, currentCandidateId, conflictingCandidateId, now) => {
      calls += 1
      if (calls === 2) throw new Error('injected failure on second conflict write')
      return realInsert(customerId, fieldPath, currentCandidateId, conflictingCandidateId, now)
    }

    expect(() => reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })).toThrow(
      'injected failure on second conflict write',
    )
    // Single enclosing db.transaction => the first (successful) conflict insert is rolled back
    // along with the second (thrown) one. Zero conflicts persist, not one.
    expect(conflicts.listUnresolved('c1')).toHaveLength(0)
  })

  it('materializes a missing candidate for every bound scalar path with no candidate', () => {
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    for (const path of boundScalarPaths('acord_125')) {
      const rows = candidates.byField('c1', path)
      expect(rows, `expected a materialized missing candidate for ${path}`).toHaveLength(1)
      expect(rows[0]!.presence).toBe('missing')
      expect(rows[0]!.evidence_quote).toBeNull()
      expect(rows[0]!.value_json).toBeNull()
    }
  })

  it('does not duplicate a missing candidate on a second reconcile', () => {
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(candidates.byField('c1', 'fein')).toHaveLength(1)
  })

  it('CRITICAL: a materialized missing placeholder must never shadow a later-arriving real candidate with an earlier source_date (AGENTS.md #7 tiebreak)', () => {
    // Reconcile at processing time with `fein` absent -> materializes a `missing` fein
    // placeholder. Before the fix, that placeholder's source_date was clock.now() (the recent
    // processing time), which lexicographically beats the real fein candidate's much-earlier
    // source_date (an actual call/transcript date) under invariant #7's source_date tiebreak —
    // so the empty placeholder would silently outrank and shadow the genuine extracted value.
    reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const placeholder = candidates.byField('c1', 'fein')
    expect(placeholder).toHaveLength(1)
    expect(placeholder[0]!.presence).toBe('missing')

    // A real, unreviewed fein candidate now arrives from a source dated well BEFORE the
    // reconcile processing time above (2025-03-15, vs. the FixedClock's 2025-03-16 reconcile time).
    candidates.insertMany([
      candidate({
        id: 'fein-real', field_path: 'fein', value_json: '"12-3456789"', presence: 'present',
        source_date: '2025-03-15T00:00:00Z', extracted_at: '2025-03-15T00:00:00Z',
      }),
    ])

    const current = selectCurrentCandidate(candidates.byField('c1', 'fein'))
    expect(current, 'expected the real present fein candidate to be current, not the missing placeholder').toBeDefined()
    expect(current!.presence).toBe('present')
    expect(current!.value_json).toBe('"12-3456789"')

    const viaProfile = currentProfileMap(candidates, reviews, 'c1').get('fein')!
    expect(viaProfile.value_json).toBe('"12-3456789"')
  })
})
