# ACORD Extraction Pipeline — Design

**Date:** 2026-07-03
**Context:** Insurance brokerage. Call transcripts arrive via webhook; an LLM drafts
structured data; a human reviews/corrects it (with provenance back to the transcript);
approved data is passed to an existing `fill_form(form_type, mapping)` service that
produces the ACORD PDF.

## Goal

Take call transcripts and produce a reviewed, human-approved field-name→value mapping
for each ACORD form (125 and 126). Optimize for **code quality and production
readiness**, not UI polish. The human review surface is modeled as a **TypeScript
client class**, not a real UI.

## Non-Goals

- No actual PDF rendering — `fillForm` is a stub returning bytes + a blob ref.
- No real web UI — review is exercised through a `ReviewClient` class.
- No auth/multi-tenant/production infra (documented as extension points, not built).

## Stack

- **TypeScript / Node.**
- **Fastify** — thin HTTP layer for the webhook.
- **Zod** — schemas + validation (the Pydantic equivalent); also the LLM structured-output schema.
- **LLM** — structured extraction via a provider-agnostic `LlmClient` interface
  (impl uses the Vercel AI SDK `generateObject`; swappable for Vertex/Bedrock). The
  interface is mockable so the whole pipeline is testable without a live model.
- **better-sqlite3** — synchronous SQLite behind a repository interface.
- **Vitest** — unit + integration tests.

## The Core Idea: Canonical Profile + Form Projections

The two ACORD forms share many fields (`mailing_address`, `employee_count_full_time/part_time`,
premises/location addresses, effective/expiration dates). Storing a separate
`JSON_125` / `JSON_126` per form duplicates those and causes edit-drift and
double review.

Instead the LLM extracts into **one form-agnostic `BusinessProfile`** — the canonical
set of facts about the customer. Each form is a **pure projection** from that profile:

```
renderAcord125(profile) -> { policyholder_first_name, mailing_address, ... }
renderAcord126(profile) -> { employee_count_full_time, gl_premises, ... }
```

A shared field lives **once**, is **reviewed once**, and flows to both renderings. This
is the answer to the DRY question: shared attributes are not stored per-form; forms are
views over the canonical model.

### A "fact" is just a field-with-metadata

Each field in the profile is not a bare scalar but a value carrying its provenance,
confidence, and review state — this is what makes provenance display, corrections, and
human-edit protection possible:

```ts
annual_gross_revenue: {
  value: 2500000,
  confidence: 0.6,
  evidence: { quote: "about two and a half million, maybe a little over", span: [1834, 1878] },
  source_id: "src_001",
  review_status: "needs_review"   // -> "approved" once a human confirms/edits
}
```

"Facts" is not a separate subsystem — it is the field shape of the canonical profile.

## Components (clean boundaries)

| Module | Responsibility | Depends on |
|---|---|---|
| `ingest/webhook` | Validate payload, dedupe by source id, persist raw source, enqueue processing, return 202 | sources repo, job queue |
| `storage/sources` | Append-only raw-source store (source of truth) | sqlite |
| `extraction/extractor` | transcript(s) → Zod-validated facts w/ provenance + confidence | `LlmClient` |
| `profile/reconciler` | Merge fact candidates into canonical profile; conflict detection | facts repo |
| `forms/renderers` | Pure `profile → {field name: value}` projections for 125 & 126 | — |
| `forms/fillForm` | Stub: `(formType, mapping) → bytes`; writes to blob store | blob store |
| `review/ReviewClient` | The TS "UI stand-in": list/get drafts, get field + provenance, edit field, approve form (→ fillForm) | facts + drafts repos |
| `processor` | Orchestrates: new source → extract → reconcile → re-project drafts → needs_review | above |

The LLM sits behind `LlmClient` so extraction is deterministic and testable with canned structured responses.

## Data Model (SQLite)

- **sources**(`id` PK, `customer_id`, `type`, `source_date`, `received_at`, `raw_json`,
  `checksum`, `status`) — append-only; source of truth.
- **facts**(`id` PK, `customer_id`, `field_path`, `value_json`, `confidence`,
  `evidence_quote`, `evidence_span_start`, `evidence_span_end`, `source_id`,
  `extracted_at`, `review_status`, `reviewed_value_json`, `reviewed_by`, `reviewed_at`,
  `superseded_by`) — append-only ledger. Current value = latest non-superseded row per
  (`customer_id`, `field_path`).
- **form_drafts**(`id` PK, `customer_id`, `form_type`, `projected_json`, `status`
  [`needs_review`|`approved`|`filled`], `approved_by`, `approved_at`, `pdf_ref`,
  `updated_at`) — materialized projection for review + fill.
- **customers**(`id` PK, `name`, `dba`, `owner`) — minimal.

The append-only `facts` ledger is what enables audit + correction detection. A simpler
"current-value-only" variant is possible and noted as the MVP fallback.

### Customer identity

Transcripts carry no customer id, so the **webhook envelope** carries
`{ customer_id, source }` (realistic — the calling system knows the account). The
provided `transcripts.json` array is treated as individual sources delivered under one
`customer_id`.

## Multiple / Out-of-Order / Correction Transcripts

Each transcript contributes fact candidates keyed by `field_path` + `source_id`, stamped
with the **transcript's own `date`** (not arrival time). The reconciler computes the
current value per field:

1. **Human override wins.** If a field was reviewed/approved, the reviewed value is
   current.
2. **A newer conflicting extraction does not silently overwrite an approved value** — it
   is recorded and the field is flagged `conflict` for re-review.
3. Otherwise **newest `source_date` wins**; tie → **highest confidence**.

Because ordering is by `source_date`, a late-arriving *older* transcript cannot clobber
newer info, and a genuine correction in a later call supersedes the earlier value.

## Extraction Judgment (from the sample transcript)

The extractor must handle messy speech and prefer flagging over inventing precision:

- Revenue "about 2.5M… north of 2M" → `2500000`, low confidence, flag *approximate*.
- Payroll "1.7 or 1.8, I'll get back to you" → **blank**, flag *missing*.
- Two addresses → office `1420 Marine Drive` = premises/location; `PO Box 9102` = `mailing_address`.
- Employees "45 total, ~35 FT, ~10 PT" → FT 35 / PT 10.
- DBA "Coastal Roof & Repair"; entity LLC / sole owner / started 2018; FEIN 12-3456789;
  prior carrier Hartford, expires Sep 1, ~$110k.
- Claims are WC (ladder, $30k) + auto (fence, $15k) → loss-history, **not** 126 GL coverage fields.

## Failure Handling / Production Readiness

- Webhook **persists raw source before processing** → a transcript is never lost to a
  slow/failing LLM.
- Ingest returns `202` immediately; processing is async (in-process queue in the
  prototype; SQS/PubSub in prod — documented extension point).
- Processor retries with backoff; on repeated failure `source.status = error` and the job
  dead-letters. Draft stays in its prior state; **nothing is auto-submitted** — the human
  gate is the safety net.
- **Idempotency:** sources deduped by id/checksum; reprocessing is safe because facts are
  keyed by `source_id` (upsert, not append-duplicate).

## Testing Strategy

- **Unit:** renderers (profile→fields, incl. shared fields), reconciler (corrections,
  out-of-order, human-edit protection), extractor with mocked `LlmClient`, `ReviewClient`.
- **Integration:** webhook → process → draft → review → edit → approve → fillForm, mock LLM.
- **Fixtures:** the real `transcripts.json` plus a synthetic correction transcript (e.g. a
  revenue correction / payroll follow-up) to exercise the multi-transcript path.

## Prototype Build Order

1. Schemas: `BusinessProfile` (Zod), fact shape, form field types.
2. Storage: sqlite repos (sources, facts, drafts) + blob store.
3. Extractor + `LlmClient` interface + mock.
4. Reconciler (the reducer + conflict detection).
5. Form renderers (125, 126) — the DRY payoff.
6. Processor orchestration.
7. `fillForm` stub.
8. `ReviewClient` class.
9. Webhook (Fastify) + async job wiring.
10. Tests throughout.

## Alternatives Considered

- **Flat `JSON_125`/`JSON_126` per form (plan.md's sketch):** simplest, maps 1:1 to
  `fill_form`, but duplicates shared fields and discards the per-source provenance needed
  for corrections/audit. Presented as the MVP; canonical-projection is the target.
- **Re-extract everything on each new transcript:** simplest merge story but clobbers
  human edits and is costly/non-deterministic. Rejected in favor of source-dated
  candidate reconciliation.
- **Split Python + TS:** most production-realistic but two languages in a short build;
  rejected for single-language clarity.
