import type { ExtractedFieldCandidatesRepo } from '../db/repos/extractedFieldCandidates'
import type { FieldReviewVersionsRepo } from '../db/repos/fieldReviewVersions'
import type { CurrentFieldValue } from '../schema/profile'

export function currentProfileMap(
  candidates: ExtractedFieldCandidatesRepo,
  reviews: FieldReviewVersionsRepo,
  customerId: string,
): Map<string, CurrentFieldValue> {
  const candidateMap = candidates.currentCandidateMap(customerId)
  const reviewMap = reviews.latestMap(customerId)
  const out = new Map<string, CurrentFieldValue>()

  for (const [fieldPath, selectedCandidate] of candidateMap) {
    const review = reviewMap.get(fieldPath) ?? null
    const valueCandidate = review ? candidates.get(review.candidate_id) : selectedCandidate
    if (!valueCandidate) throw new Error(`missing candidate for review ${review!.id}`)
    const value_json = review ? review.value_json : selectedCandidate.value_json
    const presence = review ? review.presence : selectedCandidate.presence
    out.set(fieldPath, {
      field_path: fieldPath,
      selected_candidate: selectedCandidate,
      value_candidate: valueCandidate,
      review,
      value_json,
      presence,
      review_status: review ? 'approved' : 'needs_review',
      approved_blank: review !== null && presence !== 'present',
    })
  }

  return out
}
