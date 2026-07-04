import { describe, it, expect } from 'vitest'
import { contentHash, itemIdFor, factIdFor } from '../../src/util/hash'

describe('contentHash', () => {
  it('is stable regardless of key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }))
  })
  it('changes when a value changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
  })
})

describe('itemIdFor', () => {
  it('is deterministic for the same natural key', () => {
    expect(itemIdFor('cust1', 'claims', '2023|workers_comp'))
      .toBe(itemIdFor('cust1', 'claims', '2023|workers_comp'))
  })
  it('differs across collections and customers', () => {
    expect(itemIdFor('cust1', 'claims', 'k')).not.toBe(itemIdFor('cust1', 'locations', 'k'))
    expect(itemIdFor('cust1', 'claims', 'k')).not.toBe(itemIdFor('cust2', 'claims', 'k'))
  })
})

describe('factIdFor', () => {
  it('is identical for the same (customer, field, source) — idempotent reprocessing', () => {
    expect(factIdFor('c1', 'annual_gross_revenue', 's1')).toBe(factIdFor('c1', 'annual_gross_revenue', 's1'))
  })
  it('differs across sources so multi-transcript candidates coexist', () => {
    expect(factIdFor('c1', 'annual_gross_revenue', 's1')).not.toBe(factIdFor('c1', 'annual_gross_revenue', 's2'))
  })
})
