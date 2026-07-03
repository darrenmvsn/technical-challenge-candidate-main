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
| `forms/fillForm` | Stub: `(formType, mapping) → bytes`; writes to blob store at a deterministic key | blob store |
| `review/ReviewClient` | The TS "UI stand-in": list/get drafts, get field + provenance, `approveForm(edits?)` (one short txn) | facts + drafts + outbox repos |
| `outbox/worker` | In-process relay: wake-on-commit + adaptive backstop poll; claims outbox rows, calls `fillForm`, `approved→filled`, per-row retry backoff | outbox repo, fillForm |
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
- **outbox**(`id` PK, `customer_id`, `form_type`, `payload_json` (the approved mapping),
  `status` [`pending`|`processing`|`done`|`dead`], `attempts`, `next_attempt_at`,
  `locked_at`, `created_at`) — durable intent-to-fill; written in the same transaction as
  the approval.
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

## Approval, Atomicity & the Outbox

Editing-a-correction and approving are the **same action** — approval optionally carries
edits. One method, one short transaction:

```ts
reviewClient.approveForm(customerId, "acord_125", { edits: { annual_gross_revenue: 2800000 } })
```

The transaction does DB-only work and nothing else:

1. Apply human edits → facts get `review_status: "approved"`, `reviewed_value` set.
2. **Re-project** the form draft JSON from the just-corrected state (persisted JSON and
   the PDF input are therefore guaranteed identical — no drift).
3. `form_drafts.status = approved`.
4. Insert an **outbox** row (`pending`) carrying the approved mapping.
5. **Commit.**

### Why an outbox and not a synchronous `fillForm`

**Never hold a DB transaction open across an external I/O call.** Calling `fillForm`
(PDF render + blob upload) inside the approve transaction would hold SQLite's
**single writer** lock for a network round-trip, serializing every other approval behind
the slowest external call. It also couples the review workflow's availability to the PDF
service — a `fillForm` outage would block approvals and a transient blip would roll back a
human's sign-off, forcing a re-click.

The atomic unit that *must* be atomic is **{corrected JSON + approval + intent-to-fill}** —
all DB, one transaction. The PDF is a **downstream effect**, not part of the decision.
`approveForm()` returns the instant the decision is durable (read-your-writes on the
approval); the PDF follows a beat later and status flows `approved → filled`.

### Capture & consume (this system)

**In-process transactional outbox with a polling relay. No CDC, no external broker** —
CDC (Debezium/Kafka) is both over-weight for one PDF worker and unavailable on SQLite
(no logical-replication CDC). The outbox table *is* the queue.

- **Wake-on-commit (primary):** the in-process worker is nudged the moment the approve
  transaction commits → PDF starts in sub-100ms.
- **Adaptive backstop poll:** only a durability net for signals lost to a crash/restart.
  Drain when kicked; when a poll finds nothing, back off (~1s → ~30s ceiling), snap back on
  work. It exists so a crash can't strand an approved form, not to notice normal approvals.
- **Claim a batch atomically:** `UPDATE outbox SET status='processing', locked_at=? WHERE
  status='pending' LIMIT n` — trivial under SQLite's single writer.
- **Per-row retry backoff:** on `fillForm` failure, bump `attempts` + set `next_attempt_at`
  (exponential: 5s → 30s → 2m → 10m…); the poller skips future-dated rows; dead-letter
  (`status='dead'`) after N.
- **Idempotency:** `fillForm` writes to a **deterministic blob key**
  `pdf/{customerId}/{formType}/{contentHash}`, so at-least-once delivery / retries
  overwrite the same object — never a duplicate or wrong-data PDF. Effectively
  exactly-once *fulfillment*, plus an audit trail of attempts.

### Upgrade seams (built as labels, not code)

Because the write path only ever *writes a row*, both scale-ups are non-invasive and
independent — neither touches `approveForm`:

1. **Consume side:** swap the in-process worker for **SQS/PubSub + a worker fleet**.
2. **Capture side:** swap polling for **CDC/Debezium** — only once already on Postgres +
   Kafka for other reasons and polling latency/load actually hurts.

### Shared-field ripple

Forms are projections of one profile, so editing a **shared** field (e.g.
`mailing_address`) while approving ACORD 125 changes the value ACORD 126 also draws from.
An already-approved/filled ACORD 126 is therefore bumped back to `needs_review` (flagged),
never silently overwritten. Approval stays per-form; shared edits ripple as **re-review**.

## Extraction Contract (stack-agnostic)

The LLM fills the **domain model** (`BusinessProfile`), never ACORD field names — form
field names are applied by the renderers, so a form rename is a compile error, not model
drift.

The schema is an **envelope**, not bare values — each field is
`{ value: T | null, confidence: number, evidence: string }`, with `null` meaning
*not stated, do not guess*, and enums (e.g. `entity_type`) constraining the model to valid
values. This carries the provenance and confidence the review step needs.

**The core pattern is identical across libraries:** give the model a schema →
constrained/guided generation for shape → **validate the result at runtime** → hand the app
a **statically-typed object only if it passes**, else retry, else throw.

- **Pydantic AI** — `output_type=Model`; defaults to tool-output (also `NativeOutput` /
  `PromptedOutput`); Pydantic validation; built-in output retries (`ModelRetry`).
- **AI SDK + Zod** — `schema: ZodType`; native/tool structured output; Zod validation;
  throws on invalid output.

We hide the difference behind the **`LlmClient` interface** and wrap the call with
**bounded retries**, so app-level behaviour is the same either way (and the whole design
ports to Python/Pydantic AI unchanged — swap Zod→Pydantic, `generateObject`→`Agent`).

**Two things this guarantees, and one it does not:**
- Runtime validation makes the static type **sound for shape** — past the single
  parse-at-boundary point, the reconciler, renderers, and `ReviewClient` trust their inputs.
- **Evidence spans are computed in code, not trusted from the model** — the model returns a
  verbatim quote; we `indexOf` it in the transcript for the `[start,end]` span. Quote not
  found → downgrade the field to low-confidence / `needs_review` (paraphrase = hallucination
  signal).
- **Schema validation proves shape, not truth.** A hallucinated-but-valid `number` still
  passes. Correctness of *values* rests on provenance, evidence spans, confidence, and the
  human approval gate — never on the schema alone.

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
- **Outbox worker:** claim/lease, retry backoff + dead-letter, idempotent re-delivery
  (same deterministic key → no dup), wake-on-commit vs backstop-poll paths.
- **Integration:** webhook → process → draft → review → edit → `approveForm` → outbox →
  worker → `fillForm` → `filled`, mock LLM; plus shared-field ripple to `needs_review`.
- **Fixtures:** the real `transcripts.json` plus a synthetic correction transcript (e.g. a
  revenue correction / payroll follow-up) to exercise the multi-transcript path.

## Prototype Build Order

1. Schemas: `BusinessProfile` (Zod), fact shape, form field types.
2. Storage: sqlite repos (sources, facts, drafts) + blob store.
3. Extractor + `LlmClient` interface + mock.
4. Reconciler (the reducer + conflict detection).
5. Form renderers (125, 126) — the DRY payoff.
6. Processor orchestration.
7. `fillForm` stub + deterministic blob key.
8. `ReviewClient.approveForm` (short txn: edits + approval + outbox row) + shared-field ripple.
9. Outbox worker (wake-on-commit + adaptive backstop poll + per-row retry backoff).
10. Webhook (Fastify) + async job wiring.
11. Tests throughout.

## Alternatives Considered

- **Flat `JSON_125`/`JSON_126` per form (plan.md's sketch):** simplest, maps 1:1 to
  `fill_form`, but duplicates shared fields and discards the per-source provenance needed
  for corrections/audit. Presented as the MVP; canonical-projection is the target.
- **Re-extract everything on each new transcript:** simplest merge story but clobbers
  human edits and is costly/non-deterministic. Rejected in favor of source-dated
  candidate reconciliation.
- **Synchronous `fillForm` inside the approve transaction:** matches "approve → PDF now"
  literally, but holds SQLite's single-writer lock across external I/O and couples review
  availability to the PDF service. Rejected for the outbox.
- **CDC (Debezium/Kafka) to capture the outbox:** correct at scale with existing Kafka,
  but over-weight for one worker and unavailable on SQLite. Deferred as a capture-side seam.
- **Split Python + TS:** most production-realistic but two languages in a short build;
  rejected for single-language clarity.
