import type { Fact, FormType } from '../schema/profile.js'
import type { FieldBinding, FillMapping, FormMapping, JsonValue, RenderResult } from '../schema/forms.js'
import { STATIC_BINDINGS, COLLECTION_BINDINGS } from './bindings.js'

/** Effective value: a human-approved correction (reviewed_value_json) overrides the machine value. */
export function effectiveValueJson(f: Fact): string | null {
  return f.review_status === 'approved' && f.reviewed_value_json !== null ? f.reviewed_value_json : f.value_json
}
const val = (f: Fact | undefined): string | number | null => {
  if (!f) return null
  const raw = effectiveValueJson(f)
  return raw === null ? null : JSON.parse(raw)
}

/** Distinct item_ids present for a collection, sorted for deterministic positional order. */
function itemIdsFor(collection: string, facts: Map<string, Fact>): string[] {
  const ids = new Set<string>()
  for (const path of facts.keys()) {
    const m = path.match(new RegExp(`^${collection}\\.([^.]+)\\.`))
    if (m) ids.add(m[1]!)
  }
  return [...ids].sort()
}

export function renderForm(formType: FormType, facts: Map<string, Fact>): RenderResult {
  const mapping: FormMapping = {}
  const fieldBindings: FieldBinding[] = []

  for (const b of STATIC_BINDINGS[formType]) {
    mapping[b.form_field_path] = val(facts.get(b.profile_field_path))
    fieldBindings.push({ form_field_path: b.form_field_path, profile_field_path: b.profile_field_path })
  }

  for (const coll of COLLECTION_BINDINGS[formType]) {
    const ids = itemIdsFor(coll.collection, facts)
    ids.forEach((itemId, i) => {
      for (const field of coll.fields) {
        const formPath = `${coll.form_prefix}[${i}].${field}`
        const profilePath = `${coll.collection}.${itemId}.${field}`
        mapping[formPath] = val(facts.get(profilePath))
        fieldBindings.push({ form_field_path: formPath, profile_field_path: profilePath })
      }
    })
  }

  return { mapping, fieldBindings }
}

/** Reverse an ACORD field path to a profile path: array paths via per-draft bindings, scalars via static. */
export function reverseResolve(
  formType: FormType, formFieldPath: string, draftBindings: FieldBinding[],
): string | undefined {
  const perDraft = draftBindings.find(b => b.form_field_path === formFieldPath)
  if (perDraft) return perDraft.profile_field_path
  const stat = STATIC_BINDINGS[formType].find(b => b.form_field_path === formFieldPath)
  return stat?.profile_field_path
}

/** All profile field paths a form reads (scalars only; collections resolved per-draft). */
export function boundScalarPaths(formType: FormType): string[] {
  return STATIC_BINDINGS[formType].map(b => b.profile_field_path)
}

/**
 * Unflatten a FLAT review mapping into the NESTED shape the real `fill_form` service expects
 * (README): dotted keys (`mailing_address.street`) become nested objects and bracketed keys
 * (`claims[0].amount`) become arrays of objects, e.g.
 *   { fein, 'mailing_address.street': 'PO Box 9102', 'claims[0].amount': 30000 }
 *     -> { fein, mailing_address: { street: 'PO Box 9102' }, claims: [ { amount: 30000 } ] }
 * The flat mapping stays the human review surface + draft projection; this nested mapping is
 * what we persist as the outbox payload and hand to `fillForm`. Pure and deterministic — same
 * flat mapping always yields the same nested object. renderForm emits contiguous array indices
 * (0..n-1) in sorted item order, so arrays are dense and correctly ordered.
 */
export function toFillMapping(flat: FormMapping): FillMapping {
  const root: Record<string, JsonValue> = {}
  for (const [flatKey, value] of Object.entries(flat)) {
    // "claims[0].amount" -> ["claims", 0, "amount"]; "mailing_address.street" -> [..., "street"]
    const segments: (string | number)[] = []
    for (const part of flatKey.split('.')) {
      const m = part.match(/^(.+?)\[(\d+)\]$/)
      if (m) { segments.push(m[1]!, Number(m[2]!)) } else { segments.push(part) }
    }
    // Walk the path, materialising an array when the next segment is a numeric index else an object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutable heterogeneous cursor
    let cur: any = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      if (cur[seg] === undefined) cur[seg] = typeof segments[i + 1] === 'number' ? [] : {}
      cur = cur[seg]
    }
    cur[segments[segments.length - 1]!] = value
  }
  return root
}
