import { describe, it, expect } from 'vitest'
import { fillForm } from '../../src/forms/fillForm.js'
import { MemoryBlobStore } from '../../src/blob/blobStore.js'

describe('fillForm', () => {
  it('writes to a deterministic key derived from content', async () => {
    const blob = new MemoryBlobStore()
    const r1 = await fillForm('c1', 'acord_125', { fein: '12-3456789' }, blob)
    const r2 = await fillForm('c1', 'acord_125', { fein: '12-3456789' }, blob)
    expect(r1.pdf_ref).toBe(r2.pdf_ref)               // idempotent key
    expect(await blob.get(r1.pdf_ref)).not.toBeNull()
  })
  it('different content -> different key', async () => {
    const blob = new MemoryBlobStore()
    const a = await fillForm('c1', 'acord_125', { fein: 'A' }, blob)
    const b = await fillForm('c1', 'acord_125', { fein: 'B' }, blob)
    expect(a.pdf_ref).not.toBe(b.pdf_ref)
  })
  it('persists the nested fill_form contract shape verbatim (objects + arrays)', async () => {
    const blob = new MemoryBlobStore()
    const fill = {
      fein: '12-3456789',
      mailing_address: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' },
      claims: [ { year: 2023, amount: 30000 } ],
    }
    const r = await fillForm('c1', 'acord_125', fill, blob)
    const stored = JSON.parse((await blob.get(r.pdf_ref))!.toString())
    expect(stored.mapping).toEqual(fill)   // nested structure round-trips into the "PDF"
  })
  it('key format matches pdf/{customerId}/{formType}/{contentHash}', async () => {
    const blob = new MemoryBlobStore()
    const r = await fillForm('cust-42', 'acord_126', { annual_payroll: 1 }, blob)
    expect(r.pdf_ref).toBe(`pdf/cust-42/acord_126/${r.content_hash}`)
  })
  it('get on a missing key returns null explicitly', async () => {
    const blob = new MemoryBlobStore()
    expect(await blob.get('pdf/does/not/exist')).toBeNull()
  })
  it('blobStore put/get round-trips bytes verbatim', async () => {
    const blob = new MemoryBlobStore()
    const bytes = Buffer.from('hello world')
    await blob.put('k1', bytes)
    expect(await blob.get('k1')).toEqual(bytes)
  })
})
