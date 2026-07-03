import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { reconcile } from '../../src/profile/reconciler.js'
import { FixedClock } from '../../src/clock.js'
import type { Fact } from '../../src/schema/profile.js'

function fact(o: Partial<Fact>): Fact {
  return {
    id: Math.random().toString(36).slice(2), customer_id: 'c1', field_path: 'annual_gross_revenue',
    value_json: '2500000', presence: 'present', confidence: 0.5, evidence_quote: null,
    evidence_span_start: null, evidence_span_end: null, match_quality: 'exact', source_id: 's1',
    source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    review_status: 'needs_review', reviewed_value_json: null, reviewed_by: null, reviewed_at: null,
    superseded_by: null, ...o,
  }
}

describe('reconcile', () => {
  let db: DB, facts: FactsRepo, conflicts: ConflictsRepo
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  beforeEach(() => { db = openDb(); migrate(db); facts = new FactsRepo(db); conflicts = new ConflictsRepo(db) })

  it('writes a conflict when a newer machine fact disagrees with an approved one, without overwriting the current fact', () => {
    facts.insertMany([
      fact({ id: 'a', review_status: 'approved', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b', review_status: 'needs_review', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const open = conflicts.listUnresolved('c1')
    expect(open).toHaveLength(1)
    expect(open[0]!.current_fact_id).toBe('a')
    expect(open[0]!.conflicting_fact_id).toBe('b')

    // The approved fact ('a') is never mutated by reconcile — both rows persist verbatim on
    // the append-only ledger, and the CURRENT winner is whichever selectCurrentFact ranks
    // first (approval beats a newer machine candidate), never a silent overwrite.
    const revenueFacts = facts.byField('c1', 'annual_gross_revenue')
    expect(revenueFacts).toHaveLength(2)
    const approved = revenueFacts.find(f => f.id === 'a')!
    expect(approved.value_json).toBe('2500000')
    expect(approved.review_status).toBe('approved')
    const machine = revenueFacts.find(f => f.id === 'b')!
    expect(machine.value_json).toBe('2800000')
  })

  it('reconciling the SAME two-source disagreement twice is a no-op (no duplicate conflict rows)', () => {
    facts.insertMany([
      fact({ id: 'a', review_status: 'approved', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b', review_status: 'needs_review', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(conflicts.listUnresolved('c1')).toHaveLength(1)
    expect(facts.byField('c1', 'annual_gross_revenue')).toHaveLength(2)
  })

  it('materializes a missing fact (null evidence, no value) for bound fields never mentioned', () => {
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const fein = facts.byField('c1', 'fein')
    expect(fein).toHaveLength(1)
    expect(fein[0]!.presence).toBe('missing')
    expect(fein[0]!.value_json).toBeNull()
    expect(fein[0]!.evidence_quote).toBeNull()
  })

  it('materializes a missing fact for every bound scalar path with no fact', () => {
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    for (const path of [
      'policyholder_first_name', 'policyholder_last_name', 'dba_name', 'entity_type', 'fein',
      'employee_count_full_time', 'employee_count_part_time',
      'mailing_address.street', 'mailing_address.city', 'mailing_address.state', 'mailing_address.zip',
    ]) {
      const rows = facts.byField('c1', path)
      expect(rows, `expected a materialized missing fact for ${path}`).toHaveLength(1)
      expect(rows[0]!.presence).toBe('missing')
      expect(rows[0]!.evidence_quote).toBeNull()
    }
  })

  it('does not duplicate a missing fact on a second reconcile', () => {
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(facts.byField('c1', 'fein')).toHaveLength(1)
  })

  it('is all-or-nothing: a mid-batch failure rolls back every conflict write from that call (AGENTS.md #5/#12)', () => {
    // Two independently-disagreeing fields in one reconcile() call, so the conflict-detection
    // loop attempts two conflict inserts in a single invocation.
    facts.insertMany([
      fact({ id: 'a1', field_path: 'annual_gross_revenue', review_status: 'approved', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b1', field_path: 'annual_gross_revenue', review_status: 'needs_review', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
      fact({ id: 'a2', field_path: 'employee_count_full_time', review_status: 'approved', value_json: '5', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b2', field_path: 'employee_count_full_time', review_status: 'needs_review', value_json: '8', source_date: '2025-03-15T00:00:00Z' }),
    ])
    // Deliberate failure injection to prove atomicity (AGENTS.md #1 permits `any`-free
    // monkeypatching for this): shadow the instance method with a spy that throws on the
    // 2nd conflict write. `insert` is a plain (non-readonly) method, so this needs no cast.
    let calls = 0
    const realInsert = conflicts.insert.bind(conflicts)
    conflicts.insert = (customerId, fieldPath, currentFactId, conflictingFactId, now) => {
      calls += 1
      if (calls === 2) throw new Error('injected failure on second conflict write')
      return realInsert(customerId, fieldPath, currentFactId, conflictingFactId, now)
    }

    expect(() => reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })).toThrow(
      'injected failure on second conflict write',
    )
    // Single enclosing db.transaction => the first (successful) conflict insert is rolled back
    // along with the second (thrown) one. Zero conflicts persist, not one.
    expect(conflicts.listUnresolved('c1')).toHaveLength(0)
  })

  it('reconciling the SAME source twice yields an identical ledger overall (no dupes anywhere)', () => {
    facts.insertMany([
      fact({ id: 'a', review_status: 'approved', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b', review_status: 'needs_review', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const totalAfterFirst = facts.allFieldPaths('c1')
      .flatMap(p => facts.byField('c1', p)).length
    const conflictsAfterFirst = conflicts.listUnresolved('c1').length

    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const totalAfterSecond = facts.allFieldPaths('c1')
      .flatMap(p => facts.byField('c1', p)).length
    const conflictsAfterSecond = conflicts.listUnresolved('c1').length

    expect(totalAfterSecond).toBe(totalAfterFirst)
    expect(conflictsAfterSecond).toBe(conflictsAfterFirst)
  })
})
