import type { Clock } from '../clock.js'
import type { CollectionItemsRepo } from '../db/repos/collectionItems.js'
import type { ExtractionEnvelope, ExtractedFieldCandidate, EnvelopeField } from '../schema/profile.js'
import { locateEvidence } from './evidenceMatcher.js'
import { resolveItemId } from '../profile/collectionIdentity.js'
import { factIdFor } from '../util/hash.js'

export interface ExtractCtx {
  customerId: string
  sourceId: string
  sourceDate: string
  transcript: string
  clock: Clock
  itemsRepo: CollectionItemsRepo
}

/** Build one candidate at a leaf field_path with a concrete leaf value + the envelope's provenance. */
function leafFact(fieldPath: string, leafValue: unknown, ef: EnvelopeField<unknown>, ctx: ExtractCtx): ExtractedFieldCandidate {
  const loc = locateEvidence(ctx.transcript, ef.evidence)
  return {
    id: factIdFor(ctx.customerId, fieldPath, ctx.sourceId), // deterministic -> idempotent reprocessing
    customer_id: ctx.customerId,
    field_path: fieldPath,
    value_json: leafValue === null || leafValue === undefined ? null : JSON.stringify(leafValue),
    presence: ef.presence,
    confidence: ef.confidence,
    evidence_quote: ef.evidence,
    evidence_span_start: loc.span ? loc.span[0] : null,
    evidence_span_end: loc.span ? loc.span[1] : null,
    match_quality: loc.quality,
    source_id: ctx.sourceId,
    source_date: ctx.sourceDate,
    extracted_at: ctx.clock.now(),
    superseded_by: null,
  }
}

const isEnvelope = (v: unknown): v is EnvelopeField<unknown> =>
  typeof v === 'object' && v !== null && 'presence' in v && 'confidence' in v

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Envelope fields whose *present* value is a fixed nested object (mirrors the Address-typed
 * fields in schema/profile.ts), not a scalar. Extending ExtractionEnvelope with another
 * object-shaped field means adding its key here too — same mechanical-extension pattern as
 * STATIC_BINDINGS/COLLECTION_BINDINGS in forms/bindings.ts.
 */
const OBJECT_SHAPED_FIELDS = new Set(['mailing_address', 'premises_address'])

/**
 * Emit candidates for one envelope field. A scalar value -> one candidate at `key`. A fixed nested
 * object value (e.g. mailing_address {street,city,...}) -> one LEAF candidate per key
 * (`mailing_address.street`, ...) so paths line up with the form bindings. An object-shaped
 * field that is `missing`/`needs_follow_up` (value null) emits NOTHING here — there is no
 * leaf key set to read off a null value, so the reconciler (Task 10) is the one that
 * materializes each bound leaf path (`mailing_address.street`, ...) as `missing` on its own.
 */
function emitEnvelope(key: string, ef: EnvelopeField<unknown>, ctx: ExtractCtx, out: ExtractedFieldCandidate[]): void {
  if (isPlainObject(ef.value)) {
    for (const [leaf, leafVal] of Object.entries(ef.value)) {
      out.push(leafFact(`${key}.${leaf}`, leafVal, ef, ctx))
    }
  } else if (ef.value === null && OBJECT_SHAPED_FIELDS.has(key)) {
    return
  } else {
    out.push(leafFact(key, ef.value, ef, ctx))
  }
}

/** Flatten a validated envelope into candidate rows (scalars, nested-object leaves, collection items). */
export function extractFacts(env: ExtractionEnvelope, ctx: ExtractCtx): ExtractedFieldCandidate[] {
  const candidates: ExtractedFieldCandidate[] = []
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) continue
    if (Array.isArray(val)) {
      for (const item of val) {
        const itemId = resolveItemId(ctx.itemsRepo, ctx.clock, ctx.customerId, key, item.natural_key)
        for (const [field, ef] of Object.entries(item)) {
          if (field === 'natural_key' || !isEnvelope(ef)) continue
          emitEnvelope(`${key}.${itemId}.${field}`, ef, ctx, candidates)
        }
      }
    } else if (isEnvelope(val)) {
      emitEnvelope(key, val, ctx, candidates)
    }
  }
  return candidates
}
