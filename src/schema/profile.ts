import { z } from 'zod'

export const presenceValues = ['present', 'missing', 'needs_follow_up', 'not_applicable'] as const
export const Presence = z.enum(presenceValues)
export type Presence = z.infer<typeof Presence>

export type MatchQuality = 'exact' | 'normalized' | 'ambiguous' | 'none'
export type FormType = 'acord_125' | 'acord_126'

/**
 * Format guards for the two HARD identity signals we can silently auto-merge two customers on
 * (invariant #13). A *present* fein/email must be well-formed BEFORE it is persisted as a
 * candidate and flows into review/fill — identity resolution already format-checks these, but
 * the raw candidate value would otherwise reach the ACORD form unchecked. These are the single
 * source of truth: `identitySignalsFromEnvelope` imports the same predicates so persistence and
 * identity resolution can never drift apart.
 */
// Both predicates test the RAW value with anchored patterns (no trim/normalize/digit-count
// leniency), so any value that passes is already clean enough to persist and render onto the
// ACORD form. A digit-COUNT check would wrongly accept a labeled string like "FEIN 12-3456789"
// (9 digits present) and persist it verbatim; the anchored shape rejects anything but the
// identifier itself. Identity resolution re-normalizes these already-clean values into its own
// signal keys — see identitySignalsFromEnvelope.
const FEIN_SHAPE = /^\d{2}-?\d{7}$/           // e.g. "12-3456789" or "123456789" — nothing else
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isWellFormedFein = (value: string): boolean => FEIN_SHAPE.test(value)
export const isWellFormedEmail = (value: string): boolean => EMAIL_SHAPE.test(value)

/** A present-value format check applied by `envelopeField` only when `presence === 'present'`. */
export interface PresentFormat<V> { check: (value: V) => boolean; message: string }

/**
 * One extracted field: value + why-it-is/isn't-there + confidence + provenance quote.
 * Invariant #6: `evidence` is `null` ONLY for `presence === 'missing'`. A cross-field
 * `superRefine` rejects a present/needs_follow_up/not_applicable field with null evidence,
 * and rejects a missing field carrying evidence — so the constraint can't be silently violated.
 *
 * `presence === 'present'` additionally REQUIRES a non-null value — a present field with a null
 * value is contradictory (nothing was actually extracted) and must never be persisted as a
 * "present but empty" candidate. Only missing/needs_follow_up/not_applicable carry a null value.
 *
 * `presentFormat` (optional) additionally rejects a `present` field whose value fails a format
 * check (e.g. a malformed FEIN/email), so bad hard-identity values never reach candidates.
 */
export function envelopeField<T extends z.ZodTypeAny>(value: T, presentFormat?: PresentFormat<z.infer<T>>) {
  return z.object({
    value: value.nullable(),
    presence: Presence,
    confidence: z.number().min(0).max(1),
    evidence: z.string().nullable(), // null ONLY for a truly missing field (enforced below)
  }).superRefine((field, ctx) => {
    if (field.presence === 'missing' && field.evidence !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: "evidence must be null when presence is 'missing'" })
    }
    if (field.presence !== 'missing' && field.evidence === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: "evidence is required unless presence is 'missing'" })
    }
    if (field.presence === 'present' && field.value === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: "value is required when presence is 'present'" })
    }
    if (presentFormat && field.presence === 'present' && field.value !== null && !presentFormat.check(field.value as z.infer<T>)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: presentFormat.message })
    }
  })
}
export type EnvelopeField<T> = { value: T | null; presence: Presence; confidence: number; evidence: string | null }

const Address = z.object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() })

/**
 * The fields the pipeline extracts. This is the representative, runnable set the tests
 * exercise; extending to every schema.md field is mechanical (same envelopeField pattern).
 * Repeated collections are arrays of objects each carrying a natural_key for identity.
 */
export const ExtractionEnvelope = z.object({
  policyholder_first_name: envelopeField(z.string()).optional(),
  policyholder_last_name: envelopeField(z.string()).optional(),
  business_name: envelopeField(z.string()).optional(),
  business_phone: envelopeField(z.string()).optional(),
  policyholder_email: envelopeField(z.string(), { check: isWellFormedEmail, message: 'policyholder_email must be a valid email address when present' }).optional(),
  dba_name: envelopeField(z.string()).optional(),
  entity_type: envelopeField(z.enum(['LLC', 'Corporation', 'SoleProprietor', 'Partnership'])).optional(),
  fein: envelopeField(z.string(), { check: isWellFormedFein, message: 'fein must contain exactly 9 digits when present' }).optional(),
  annual_gross_revenue: envelopeField(z.number()).optional(),
  annual_payroll: envelopeField(z.number()).optional(),
  employee_count_full_time: envelopeField(z.number().int()).optional(),
  employee_count_part_time: envelopeField(z.number().int()).optional(),
  mailing_address: envelopeField(Address).optional(),
  premises_address: envelopeField(Address).optional(),
  prior_carrier_name: envelopeField(z.string()).optional(),
  prior_expiration_date: envelopeField(z.string()).optional(),
  claims: z.array(z.object({
    natural_key: z.string(),          // e.g. "2023|workers_comp"
    year: envelopeField(z.number().int()),
    type: envelopeField(z.string()),
    amount: envelopeField(z.number()),
    description: envelopeField(z.string()),
  })).optional(),
})
export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelope>

export type ReviewAction = 'approved' | 'edited' | 'accepted_conflict' | 'approved_blank'

/**
 * One immutable piece of machine/source evidence for a field of the canonical profile.
 * Carries NO human-review state — human decisions live only in `FieldReviewVersion`
 * (AGENTS.md invariant #7, rewritten by this ticket: current value = candidate selection
 * overlaid with the latest review version, not a review column on this row).
 */
export interface ExtractedFieldCandidate {
  id: string
  customer_id: string
  field_path: string          // scalar: "annual_gross_revenue"; item: "claims.{item_id}.amount"
  value_json: string | null
  presence: Presence
  confidence: number
  evidence_quote: string | null
  evidence_span_start: number | null
  evidence_span_end: number | null
  match_quality: MatchQuality
  source_id: string
  source_date: string
  extracted_at: string
  superseded_by: string | null
}

/** One immutable human review decision for a field, monotonically versioned per (customer, field_path). */
export interface FieldReviewVersion {
  id: string
  customer_id: string
  field_path: string
  version: number
  candidate_id: string
  value_json: string | null
  presence: Presence
  action: ReviewAction
  reviewed_by: string
  reviewed_at: string
}

/** The computed current canonical value for a field: machine selection overlaid with the latest review version. */
export interface CurrentFieldValue {
  field_path: string
  /** The machine-selected candidate by source_date > confidence > extracted_at. */
  selected_candidate: ExtractedFieldCandidate
  /** The candidate whose evidence supports value_json; equals selected_candidate when no review exists. */
  value_candidate: ExtractedFieldCandidate
  review: FieldReviewVersion | null
  value_json: string | null
  presence: Presence
  review_status: 'needs_review' | 'approved'
  approved_blank: boolean
}
