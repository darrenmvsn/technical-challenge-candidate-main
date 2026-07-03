import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { ReviewClient } from '../../src/review/reviewClient.js'
import { FixedClock } from '../../src/clock.js'
import type { Fact } from '../../src/schema/profile.js'

function seedFact(facts: FactsRepo, field_path: string, value: unknown, review_status: Fact['review_status'] = 'needs_review') {
  facts.insertMany([{
    id: field_path, customer_id: 'c1', field_path, value_json: JSON.stringify(value), presence: 'present',
    confidence: 0.9, evidence_quote: 'q', evidence_span_start: 0, evidence_span_end: 1, match_quality: 'exact',
    source_id: 's1', source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    review_status, reviewed_value_json: null, reviewed_by: null, reviewed_at: null, superseded_by: null,
  }])
}

/** A field the extractor explicitly could not find in the source (invariant #6: evidence null only for missing). */
function seedMissingFact(facts: FactsRepo, field_path: string) {
  facts.insertMany([{
    id: field_path, customer_id: 'c1', field_path, value_json: null, presence: 'missing',
    confidence: 0, evidence_quote: null, evidence_span_start: null, evidence_span_end: null, match_quality: 'none',
    source_id: 's1', source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    review_status: 'needs_review', reviewed_value_json: null, reviewed_by: null, reviewed_at: null, superseded_by: null,
  }])
}

describe('ReviewClient.approveForm', () => {
  let db: DB, facts: FactsRepo, drafts: DraftsRepo, outbox: OutboxRepo, conflicts: ConflictsRepo, rc: ReviewClient
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  const wake = vi.fn()
  beforeEach(() => {
    db = openDb(); migrate(db)
    facts = new FactsRepo(db); drafts = new DraftsRepo(db); outbox = new OutboxRepo(db); conflicts = new ConflictsRepo(db)
    rc = new ReviewClient({ db, facts, drafts, outbox, conflicts, clock, formTypes: ['acord_125', 'acord_126'], onEnqueued: wake })
    seedFact(facts, 'policyholder_first_name', 'Mike')
    seedFact(facts, 'annual_gross_revenue', 2500000)
    drafts.upsertProjection('c1', 'acord_125', { policyholder_first_name: 'Mike', annual_gross_revenue: 2500000 }, '2025-03-15T00:00:00Z')
  })

  it('applies an edit, approves ALL form-bound facts, and the EDIT reaches the outbox payload', () => {
    const res = rc.approveForm('c1', 'acord_125', { edits: { annual_gross_revenue: 2800000 }, by: 'sarah' })
    // edited fact reflects new value + approved
    expect(JSON.parse(facts.byField('c1', 'annual_gross_revenue')[0]!.reviewed_value_json!)).toBe(2800000)
    // an untouched, form-bound fact is ALSO approved
    expect(facts.byField('c1', 'policyholder_first_name')[0]!.review_status).toBe('approved')
    // the correction actually lands in the projected draft AND the outbox payload (not the stale 2.5M)
    expect(JSON.parse(outbox.get(res.outboxId)!.payload_json).annual_gross_revenue).toBe(2800000)
    expect(JSON.parse(drafts.byId(res.draftId)!.projected_json).annual_gross_revenue).toBe(2800000)
    expect(outbox.get(res.outboxId)!.status).toBe('pending')
    expect(wake).toHaveBeenCalledOnce()
  })

  it('ripples a shared-field edit to a filled OTHER form as a new needs_review revision', () => {
    // employee_count_full_time is bound in BOTH 125 and 126.
    seedFact(facts, 'employee_count_full_time', 35)
    const d126 = drafts.upsertProjection('c1', 'acord_126', { employee_count_full_time: 35 }, '2025-03-15T00:00:00Z')
    drafts.approve(d126.id, 'sarah', '2025-03-15T00:00:00Z')
    drafts.markFilled(d126.id, 'pdf/126', '2025-03-15T00:01:00Z') // 126 already filled
    // Now edit the shared field while approving 125.
    rc.approveForm('c1', 'acord_125', { edits: { employee_count_full_time: 40 }, by: 'sarah' })
    const cur126 = drafts.current('c1', 'acord_126')!
    expect(cur126.revision).toBe(2)                       // new revision created
    expect(cur126.status).toBe('needs_review')            // must be re-reviewed
    expect(drafts.byId(d126.id)!.status).toBe('filled')   // old 126 stays filled (immutable)
    expect(drafts.byId(d126.id)!.superseded_by_revision).toBe(2)
  })

  it('shared-field ripple cancels the OTHER form’s still-pending fill', () => {
    // 126 is approved with a fill still queued (not yet run by the worker).
    seedFact(facts, 'employee_count_full_time', 35)
    const d126 = drafts.upsertProjection('c1', 'acord_126', { employee_count_full_time: 35 }, '2025-03-15T00:00:00Z')
    drafts.approve(d126.id, 'sarah', '2025-03-15T00:00:00Z')
    const pending126 = outbox.enqueue('c1', 'acord_126', d126.revision, { employee_count_full_time: 35 }, 'h', '2025-03-15T00:00:00Z')
    // Now a shared field is edited while approving 125.
    rc.approveForm('c1', 'acord_125', { edits: { employee_count_full_time: 40 }, by: 'sarah' })
    // The stale 126 fill (targeting the now-superseded revision) is cancelled, not left to run.
    expect(outbox.get(pending126)!.status).toBe('cancelled')
    const cur126 = drafts.current('c1', 'acord_126')!
    expect(cur126.revision).toBe(2)
    expect(cur126.status).toBe('needs_review')
  })

  it('re-approving a filled form supersedes it onto a new revision', () => {
    const first = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    drafts.markFilled(first.draftId, 'pdf/x', '2025-03-16T00:00:00Z') // simulate worker filled it
    const second = rc.approveForm('c1', 'acord_125', { edits: { policyholder_first_name: 'Michael' }, by: 'sarah' })
    expect(second.revision).toBe(2)
    expect(drafts.byId(first.draftId)!.status).toBe('filled')  // old stays filled
    expect(drafts.byId(first.draftId)!.superseded_by_revision).toBe(2)
  })

  it('re-approving cancels a still-pending outbox row', () => {
    const first = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    const second = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    expect(outbox.get(first.outboxId)!.status).toBe('cancelled')
    expect(outbox.get(second.outboxId)!.status).toBe('pending')
  })

  it('lists and resolves conflicts', () => {
    conflicts.insert('c1', 'annual_gross_revenue', 'cur', 'confl', '2025-03-16T00:00:00Z')
    const open = rc.listUnresolvedConflicts('c1')
    expect(open).toHaveLength(1)
    rc.resolveConflict(open[0]!.id, 'sarah')
    expect(rc.listUnresolvedConflicts('c1')).toHaveLength(0)
  })

  // Additional coverage beyond the brief's 6 tests, per task-13 "Key expectations":
  // getDraft must surface the FLAT mapping + per-field provenance (including a field that was
  // never extracted at all, i.e. `presence: 'missing'`), and approving a missing/needs_follow_up
  // field with a null value (approved_blank) must be a supported, tested path — not just a
  // read-side label nobody exercises. markNotApplicable (presence flip) is intentionally NOT
  // exercised here — it is out of scope (AGENTS.md #12/deferrals).
  it('getDraft surfaces a never-extracted field as known-missing, and approving it blank marks approved_blank', () => {
    seedMissingFact(facts, 'dba_name') // bound in acord_125's STATIC_BINDINGS, never seen in any source
    const res = rc.approveForm('c1', 'acord_125', { by: 'sarah' }) // approves ALL form-bound facts, including dba_name
    const view = rc.getDraft('c1', 'acord_125')!
    expect(view.draft.id).toBe(res.draftId)
    const dba = view.fields.find(f => f.formFieldPath === 'dba_name')!
    expect(dba.value).toBeNull()
    expect(dba.provenance?.presence).toBe('missing')
    expect(dba.provenance?.quote).toBeNull()          // invariant #6: evidence null only for missing
    expect(dba.provenance?.review_status).toBe('approved')
    expect(dba.provenance?.approved_blank).toBe(true) // sign-off on leaving it blank, presence still 'missing'
    // an untouched present field still round-trips its value + evidence through the same flat view
    const rev = view.fields.find(f => f.formFieldPath === 'policyholder_first_name')!
    expect(rev.value).toBe('Mike')
    expect(rev.provenance?.quote).toBe('q')
    expect(rev.provenance?.approved_blank).toBe(false)
  })
})
