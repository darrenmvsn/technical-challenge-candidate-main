import { describe, it, expect } from 'vitest'
import { locateEvidence } from '../../src/extraction/evidenceMatcher'

const T = 'We did about two and a half million last year. About two and a half million, roughly.'

describe('locateEvidence', () => {
  it('exact single match returns a span', () => {
    const r = locateEvidence('the FEIN is 12-3456789 okay', '12-3456789')
    expect(r.quality).toBe('exact')
    expect(r.span).not.toBeNull()
  })

  it('exact span indexes the ORIGINAL transcript (slicing it reproduces the quote)', () => {
    const transcript = 'the FEIN is 12-3456789 okay'
    const r = locateEvidence(transcript, '12-3456789')
    expect(r.span).not.toBeNull()
    const [start, end] = r.span as [number, number]
    expect(transcript.slice(start, end)).toBe('12-3456789')
  })

  it('normalized match (case/whitespace) returns normalized', () => {
    const r = locateEvidence('Coastal   Roofing LLC', 'coastal roofing llc')
    expect(r.quality).toBe('normalized')
  })

  it('normalized span still indexes the ORIGINAL transcript text (differing case/whitespace)', () => {
    const transcript = 'Coastal   Roofing LLC'
    const r = locateEvidence(transcript, 'coastal roofing llc')
    expect(r.quality).toBe('normalized')
    expect(r.span).not.toBeNull()
    const [start, end] = r.span as [number, number]
    // Slicing the ORIGINAL transcript by the returned span must reproduce the
    // original (differently-cased/spaced) snippet, not the normalized query.
    expect(transcript.slice(start, end)).toBe('Coastal   Roofing LLC')
  })

  it('a quote appearing twice (once exact-case, once case-variant) is ambiguous with null span', () => {
    const r = locateEvidence(T, 'about two and a half million')
    expect(r.quality).toBe('ambiguous')
    expect(r.span).toBeNull()
  })

  it('unfound quote is none', () => {
    const r = locateEvidence(T, 'four hundred trucks')
    expect(r.quality).toBe('none')
    expect(r.span).toBeNull()
  })

  it('null quote is none', () => {
    const r = locateEvidence(T, null)
    expect(r.quality).toBe('none')
    expect(r.span).toBeNull()
  })
})
