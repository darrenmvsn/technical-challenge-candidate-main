import type { ExtractedFieldCandidate } from '../schema/profile'

/** Machine-candidate selection only: source_date > confidence > extracted_at. Human approvals live in field_review_versions. */
export function selectCurrentCandidate(candidates: ExtractedFieldCandidate[]): ExtractedFieldCandidate | undefined {
  const live = candidates.filter(c => c.superseded_by === null)
  if (live.length === 0) return undefined
  return [...live].sort((a, b) =>
    b.source_date.localeCompare(a.source_date) ||
    b.confidence - a.confidence ||
    b.extracted_at.localeCompare(a.extracted_at)
  )[0]
}
