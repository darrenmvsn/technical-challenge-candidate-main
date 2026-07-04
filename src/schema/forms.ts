import type { FormType } from './profile'
export type { FormType }

/**
 * Any JSON-serialisable value. The real `fill_form` contract (see README) accepts nested
 * objects (`mailing_address: { street, city, ... }`) and arrays (`prior_carriers: [...]`),
 * not just scalars — `FormMapping` must be able to represent them.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * FLAT review mapping: ACORD field name -> JSON value, keyed by dotted/bracketed paths
 * (`mailing_address.street`, `claims[0].amount`). This is the human-facing surface — the
 * review UI iterates these keys, edits are resolved against them, `form_drafts.projected_json`
 * stores this, and field bindings key off it. It is NOT the shape the PDF service consumes.
 */
export type FormMapping = Record<string, JsonValue>

/**
 * NESTED fill mapping: the exact shape the real `fill_form` service consumes (see README) —
 * `{ mailing_address: { street, ... }, claims: [ { amount, ... } ] }`. Built from a
 * `FormMapping` via `toFillMapping` at approve time and persisted as the outbox payload; the
 * worker hands it to `fillForm` verbatim. Structurally identical to `FormMapping` (both are
 * `Record<string, JsonValue>`), so the alias documents intent — flat-review vs nested-fill —
 * rather than being nominally enforced by the type checker.
 */
export type FillMapping = Record<string, JsonValue>

/** One resolved per-draft binding row emitted by a renderer. */
export interface FieldBinding {
  form_field_path: string      // concrete, e.g. "claims[0].amount" or "policyholder_first_name"
  profile_field_path: string   // e.g. "claims.{item_id}.amount"
}

/** `mapping` is the FLAT review mapping; `fieldBindings` key off the same flat paths. */
export interface RenderResult {
  mapping: FormMapping
  fieldBindings: FieldBinding[]
}
