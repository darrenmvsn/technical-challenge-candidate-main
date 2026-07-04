import { describe, it, expect } from 'vitest'
import { renderForm, reverseResolve, toFillMapping } from '../../src/forms/renderers'
import type { CurrentFieldValue, ExtractedFieldCandidate, FieldReviewVersion } from '../../src/schema/profile'

function candidate(field_path: string, value: unknown): ExtractedFieldCandidate {
  return {
    id: field_path, customer_id: 'c1', field_path, value_json: JSON.stringify(value),
    presence: 'present', confidence: 1, evidence_quote: null, evidence_span_start: null,
    evidence_span_end: null, match_quality: 'exact', source_id: 's', source_date: '2025-01-01T00:00:00Z',
    extracted_at: '2025-01-01T00:00:00Z', superseded_by: null,
  }
}

/** A CurrentFieldValue with no review: value_json/presence mirror the selected candidate. */
function current(field_path: string, value: unknown): CurrentFieldValue {
  const cand = candidate(field_path, value)
  return {
    field_path,
    selected_candidate: cand,
    value_candidate: cand,
    review: null,
    value_json: cand.value_json,
    presence: cand.presence,
    review_status: 'needs_review',
    approved_blank: false,
  }
}

/** A CurrentFieldValue overlaid with an approved review carrying a human-edited value. */
function currentWithReview(field_path: string, machineValue: unknown, reviewedValue: unknown): CurrentFieldValue {
  const cand = candidate(field_path, machineValue)
  const review: FieldReviewVersion = {
    id: 'rv-1', customer_id: 'c1', field_path, version: 1, candidate_id: cand.id,
    value_json: JSON.stringify(reviewedValue), presence: 'present', action: 'edited',
    reviewed_by: 'sarah', reviewed_at: '2025-01-02T00:00:00Z',
  }
  return {
    field_path,
    selected_candidate: cand,
    value_candidate: cand,
    review,
    value_json: review.value_json,
    presence: review.presence,
    review_status: 'approved',
    approved_blank: false,
  }
}

describe('renderForm', () => {
  it('renders scalar fields onto acord_125', () => {
    const facts = new Map([['policyholder_first_name', current('policyholder_first_name', 'Mike')]])
    const { mapping } = renderForm('acord_125', facts)
    expect(mapping.policyholder_first_name).toBe('Mike')
  })

  it('renders the human-approved correction, not the stale machine value', () => {
    const corrected = currentWithReview('annual_gross_revenue', 2500000, 2800000)
    const { mapping } = renderForm('acord_125', new Map([['annual_gross_revenue', corrected]]))
    expect(mapping.annual_gross_revenue).toBe(2800000)
  })

  it('expands a claims collection positionally and emits per-draft bindings', () => {
    const facts = new Map([
      ['claims.itemA.amount', current('claims.itemA.amount', 30000)],
      ['claims.itemB.amount', current('claims.itemB.amount', 15000)],
    ])
    const { mapping, fieldBindings } = renderForm('acord_125', facts)
    // positional order is by item_id for determinism
    expect(mapping['claims[0].amount']).toBe(30000)
    expect(mapping['claims[1].amount']).toBe(15000)
    const b0 = fieldBindings.find(b => b.form_field_path === 'claims[0].amount')
    expect(b0?.profile_field_path).toBe('claims.itemA.amount')
  })

  it('reverseResolve uses per-draft bindings for array paths', () => {
    const draftBindings = [{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.itemA.amount' }]
    expect(reverseResolve('acord_125', 'claims[0].amount', draftBindings)).toBe('claims.itemA.amount')
  })

  it('reverseResolve falls back to static map for scalars', () => {
    expect(reverseResolve('acord_125', 'policyholder_first_name', [])).toBe('policyholder_first_name')
  })

  it('projects a shared employee_count edit into BOTH acord_125 and acord_126 (DRY ripple)', () => {
    const facts = new Map([
      ['employee_count_full_time', current('employee_count_full_time', 42)],
      ['employee_count_part_time', current('employee_count_part_time', 7)],
    ])
    const form125 = renderForm('acord_125', facts)
    const form126 = renderForm('acord_126', facts)
    expect(form125.mapping.employee_count_full_time).toBe(42)
    expect(form125.mapping.employee_count_part_time).toBe(7)
    expect(form126.mapping.employee_count_full_time).toBe(42)
    expect(form126.mapping.employee_count_part_time).toBe(7)
    // both forms' bindings point at the exact same profile field path -> single source, two projections
    const b125 = form125.fieldBindings.find(b => b.form_field_path === 'employee_count_full_time')
    const b126 = form126.fieldBindings.find(b => b.form_field_path === 'employee_count_full_time')
    expect(b125?.profile_field_path).toBe('employee_count_full_time')
    expect(b126?.profile_field_path).toBe('employee_count_full_time')
  })

  it('acord_126 does not project 126-specific or out-of-scope fields (scope guardrail)', () => {
    const facts = new Map([
      ['policyholder_first_name', current('policyholder_first_name', 'Mike')],
      ['annual_payroll', current('annual_payroll', 500000)],
    ])
    const { mapping } = renderForm('acord_126', facts)
    expect(mapping).toEqual({
      employee_count_full_time: null,
      employee_count_part_time: null,
    })
  })
})

describe('toFillMapping', () => {
  it('nests dotted keys into the fill_form contract object shape', () => {
    const flat = {
      fein: '12-3456789',
      'mailing_address.street': 'PO Box 9102',
      'mailing_address.city': 'Wilmington',
      'mailing_address.state': 'NC',
      'mailing_address.zip': '28402',
    }
    expect(toFillMapping(flat)).toEqual({
      fein: '12-3456789',
      mailing_address: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' },
    })
  })

  it('expands bracketed indices into a dense, ordered array of objects', () => {
    const flat = {
      'claims[0].year': 2023, 'claims[0].amount': 30000,
      'claims[1].year': 2024, 'claims[1].amount': 15000,
    }
    expect(toFillMapping(flat)).toEqual({
      claims: [ { year: 2023, amount: 30000 }, { year: 2024, amount: 15000 } ],
    })
  })
})
