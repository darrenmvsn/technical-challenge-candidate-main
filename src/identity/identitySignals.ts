import { locateEvidence } from '../extraction/evidenceMatcher.js'
import type { EnvelopeField, ExtractionEnvelope } from '../schema/profile.js'

export type IdentitySignalType = 'fein' | 'email' | 'phone' | 'business_name_state' | 'mailing_address'
export type IdentitySignalStrength = 'hard' | 'supporting'
export interface IdentitySignal { type: IdentitySignalType; value: string; strength: IdentitySignalStrength }

type Address = { street: string; city: string; state: string; zip: string }

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Lowercase, collapse every run of non-alphanumeric characters to a single space, trim.
 * Used for the fuzzy-adjacent-but-actually-exact-index signal keys (business_name_state,
 * mailing_address) — deterministic and case/punctuation-insensitive, but never fuzzy: two
 * differently-worded names normalize to different strings and simply do not match.
 */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * A field is a "usable present value" only when presence === 'present', its evidence is
 * non-null, and its value is a non-empty string. Evidence verification against the
 * transcript happens separately (via locateEvidence) so callers can decide per-signal.
 */
function presentString(field: EnvelopeField<string> | undefined): { value: string; evidence: string } | null {
  if (!field || field.presence !== 'present') return null
  if (typeof field.value !== 'string' || field.value.length === 0) return null
  if (field.evidence === null) return null
  return { value: field.value, evidence: field.evidence }
}

function presentAddress(field: EnvelopeField<Address> | undefined): { value: Address; evidence: string } | null {
  if (!field || field.presence !== 'present') return null
  if (field.value === null) return null
  if (field.evidence === null) return null
  return { value: field.value, evidence: field.evidence }
}

/**
 * Builds normalized, evidence-verified identity signals from an extraction envelope.
 *
 * A signal is only emitted when its source field(s) are `present`, the field's evidence
 * quote is found in `transcript` with `locateEvidence` quality `exact` or `normalized`
 * (never `ambiguous`/`none` — this is the anti-hallucination guard), and the normalized
 * value satisfies the signal's format check.
 */
export function identitySignalsFromEnvelope(env: ExtractionEnvelope, transcript: string): IdentitySignal[] {
  const signals: IdentitySignal[] = []

  const verifyEvidence = (evidence: string): boolean => {
    const location = locateEvidence(transcript, evidence)
    return location.quality === 'exact' || location.quality === 'normalized'
  }

  // fein -> digits only; keep only exactly 9 digits; strength hard
  const fein = presentString(env.fein)
  if (fein && verifyEvidence(fein.evidence)) {
    const digits = fein.value.replace(/\D+/g, '')
    if (digits.length === 9) signals.push({ type: 'fein', value: digits, strength: 'hard' })
  }

  // email -> lowercase trim; keep only local@domain-shaped values; strength hard
  const email = presentString(env.policyholder_email)
  if (email && verifyEvidence(email.evidence)) {
    const normalized = email.value.trim().toLowerCase()
    if (EMAIL_SHAPE.test(normalized)) signals.push({ type: 'email', value: normalized, strength: 'hard' })
  }

  // phone -> digits only; keep only 10-digit US values for this fixture; strength supporting
  const phone = presentString(env.business_phone)
  if (phone && verifyEvidence(phone.evidence)) {
    const digits = phone.value.replace(/\D+/g, '')
    if (digits.length === 10) signals.push({ type: 'phone', value: digits, strength: 'supporting' })
  }

  const businessName = presentString(env.business_name)
  const normalizedBusinessName = businessName && verifyEvidence(businessName.evidence)
    ? normalizeText(businessName.value)
    : null

  const address = presentAddress(env.mailing_address)
  const verifiedAddress = address && verifyEvidence(address.evidence) ? address.value : null

  // business_name_state -> normalized business_name plus mailing_address.state when present;
  // strength supporting. Format check requires a non-empty business name AND non-empty state,
  // so both business_name and mailing_address must be independently present and evidence-verified.
  if (normalizedBusinessName && normalizedBusinessName.length > 0 && verifiedAddress) {
    const normalizedState = normalizeText(verifiedAddress.state)
    if (normalizedState.length > 0) {
      signals.push({ type: 'business_name_state', value: `${normalizedBusinessName}|${normalizedState}`, strength: 'supporting' })
    }
  }

  // mailing_address -> normalized street|city|state|zip; strength supporting
  if (verifiedAddress) {
    const street = normalizeText(verifiedAddress.street)
    const city = normalizeText(verifiedAddress.city)
    const state = normalizeText(verifiedAddress.state)
    const zip = normalizeText(verifiedAddress.zip)
    if (street.length > 0 && city.length > 0 && state.length > 0 && zip.length > 0) {
      signals.push({ type: 'mailing_address', value: `${street}|${city}|${state}|${zip}`, strength: 'supporting' })
    }
  }

  return signals
}
