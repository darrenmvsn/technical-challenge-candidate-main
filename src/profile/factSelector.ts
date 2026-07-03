import type { Fact } from '../schema/profile.js'

const approvedRank = (f: Fact): number => (f.review_status === 'approved' ? 1 : 0)

/**
 * Deterministic current-fact rule (AGENTS.md invariant #7): approval >
 * source_date > confidence > extracted_at. Never `id` / array position.
 *
 * Pure and total: no I/O, no clock reads — it only compares fields already
 * persisted on the candidates. Rows with `superseded_by` set are excluded
 * before ranking; `undefined` is returned when nothing live remains.
 *
 * `Array.prototype.sort` is stable (guaranteed since ES2019), so in the
 * (expected-empty-in-practice) case where all four precedence keys are
 * exactly equal across two candidates, the one appearing earlier in the
 * input `candidates` array is returned. That is a defined, tested fallback
 * of last resort — not an accidental dependency on insertion order — and it
 * never overrides the four precedence keys above.
 */
export function selectCurrentFact(candidates: Fact[]): Fact | undefined {
  const live = candidates.filter(c => c.superseded_by === null)
  if (live.length === 0) return undefined
  return [...live].sort((a, b) =>
    approvedRank(b) - approvedRank(a) ||
    b.source_date.localeCompare(a.source_date) ||
    b.confidence - a.confidence ||
    b.extracted_at.localeCompare(a.extracted_at)
  )[0]
}
