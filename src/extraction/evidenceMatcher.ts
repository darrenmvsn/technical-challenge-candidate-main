import type { MatchQuality } from '../schema/profile.js'

export interface EvidenceLocation {
  quality: MatchQuality
  span: [number, number] | null
}

/** All (non-overlapping-scan) start indices of `needle` in `haystack`. Empty needle -> []. */
function allIndexes(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const out: number[] = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

/** The sole element of a length-1 array, else undefined (honest under noUncheckedIndexedAccess). */
function sole(xs: number[]): number | undefined {
  return xs.length === 1 ? xs[0] : undefined
}

/**
 * Lowercases `s`, collapses every run of non-alphanumeric characters (whitespace,
 * punctuation) to a single space, and trims. Alongside the normalized string, records
 * `map[i]` = the index in the ORIGINAL `s` that produced `norm[i]`, so a match found in
 * normalized space can be translated back into a real span over the original text.
 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let lastWasSpace = true // collapses leading separators too
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    if (/[a-z0-9]/i.test(ch)) {
      norm += ch.toLowerCase()
      map.push(i)
      lastWasSpace = false
    } else if (!lastWasSpace) {
      norm += ' '
      map.push(i)
      lastWasSpace = true
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1)
    map.pop()
  }
  return { norm, map }
}

/**
 * Locates where `quote` appears in `transcript` and reports how confidently.
 *
 * Ambiguity is judged on ONE unified location set, found by matching the
 * whitespace/case/punctuation-normalized quote against the normalized transcript —
 * an exact-case occurrence is trivially also a normalized occurrence, so two
 * locations differing only by case (e.g. "about..." vs "About...") count as two
 * hits and yield 'ambiguous', not one 'exact' hit that silently ignores the other.
 * Only when exactly one normalized location exists do we ask whether the original
 * text at that location equals `quote` verbatim ('exact') or not ('normalized').
 *
 * Pure, deterministic, no I/O — a span is `[start, end)` into the ORIGINAL
 * `transcript` even when the match was located via the normalized copy.
 */
export function locateEvidence(transcript: string, quote: string | null): EvidenceLocation {
  if (quote === null) return { quality: 'none', span: null }

  const { norm: normQuote } = normalizeWithMap(quote)
  if (normQuote.length === 0) return { quality: 'none', span: null }

  const { norm: normTranscript, map } = normalizeWithMap(transcript)
  const hits = allIndexes(normTranscript, normQuote)
  if (hits.length > 1) return { quality: 'ambiguous', span: null }

  const hit = sole(hits)
  if (hit === undefined) return { quality: 'none', span: null }

  const start = map[hit]
  const end = map[hit + normQuote.length - 1]
  if (start === undefined || end === undefined) return { quality: 'none', span: null }

  const span: [number, number] = [start, end + 1]
  const quality: MatchQuality = transcript.slice(span[0], span[1]) === quote ? 'exact' : 'normalized'
  return { quality, span }
}
