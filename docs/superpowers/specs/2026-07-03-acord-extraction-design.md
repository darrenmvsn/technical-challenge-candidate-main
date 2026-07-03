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
- **LLM** — structured extraction via a provider-agnostic `LlmClient` interface. The
  reference impl uses the Vercel AI SDK's current structured-output API —
  `generateText({ output: Output.object({ schema }) })` (the older `generateObject` still
  works and is equivalent) — swappable for Vertex/Bedrock. The interface is mockable so the
  whole pipeline is testable without a live model.
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
  presence: "present",            // see presence states below
  confidence: 0.6,
  evidence: { quote: "about two and a half million, maybe a little over", span: [1834, 1878] },
  source_id: "src_001",
  review_status: "needs_review"   // -> "approved" once a human confirms/edits
}
```

"Facts" is not a separate subsystem — it is the field shape of the canonical profile.

### Presence states (a bare `null` is too vague)

An absent value has a *reason*, and the reasons drive different UI and different
downstream behaviour. Two orthogonal axes:

- **`presence`** (why a value is / isn't there): `present` · `missing` (transcript never
  mentioned it) · `needs_follow_up` (mentioned but the customer deferred — e.g. payroll
  "I'll get back to you") · `not_applicable` (doesn't apply to this business).
- **`review_status`** (workflow state): `needs_review` · `approved` · `conflict`.

The composite the reviewer cares about, **`approved_blank`**, is simply
`review_status = approved` on a non-`present` field — a human deliberately signed off on
leaving it empty (distinct from an unreviewed `missing`). Modeling reason separately from
review state is what lets the UI say "customer will follow up" vs "we forgot to ask" vs
"human confirmed N/A" instead of a single ambiguous blank.

## Components (clean boundaries)

| Module | Responsibility | Depends on |
|---|---|---|
| `ingest/webhook` | Validate payload, dedupe by source id, **in one txn** persist raw source + insert `processing_jobs` row, return 202 | sources + jobs repos |
| `storage/sources` | Append-only raw-source store (source of truth) | sqlite |
| `extraction/extractor` | transcript(s) → Zod-validated facts w/ provenance + confidence | `LlmClient` |
| `profile/reconciler` | Merge fact candidates into canonical profile; conflict detection | facts repo |
| `forms/bindings` | Static `(formType, formFieldPath) ↔ profileFieldPath` map; forward for renderers, reverse for `approveForm` edits | — |
| `forms/renderers` | Pure `profile → {field name: value}` projections for 125 & 126, driven by `bindings` | bindings |
| `forms/fillForm` | Stub: `(formType, mapping) → bytes`; writes to blob store at a deterministic key | blob store |
| `review/ReviewClient` | The TS "UI stand-in": list/get drafts, get field + provenance, `approveForm(edits?)` (one short txn) | facts + drafts + outbox repos, bindings |
| `worker/processor` | Claims `processing_jobs` (lease): extract → reconcile → re-project drafts → needs_review; retry/dead-letter | jobs repo, extractor, reconciler |
| `worker/outboxWorker` | Claims `outbox` (lease): wake-on-commit + adaptive backstop poll; calls `fillForm`, `approved→filled`, per-row retry backoff | outbox repo, fillForm |
| `worker/leaseClaimer` | Shared claim primitive: atomically lease pending/expired rows with `locked_until`; reclaim on worker crash | sqlite |

The LLM sits behind `LlmClient` so extraction is deterministic and testable with canned structured responses.

## Data Model (SQLite)

- **sources**(`id` PK, `customer_id`, `type`, `source_date`, `received_at`, `raw_json`,
  `checksum`, `status`) — append-only; source of truth.
- **processing_jobs**(`id` PK, `source_id`, `customer_id`, `status`
  [`pending`|`processing`|`done`|`dead`], `attempts`, `next_attempt_at`, `locked_until`,
  `created_at`) — durable ingest work-queue; written **in the same txn** as the source so a
  process crash can never lose a transcript (see Durable Processing).
- **facts**(`id` PK, `customer_id`, `field_path`, `value_json`, `presence`
  [`present`|`missing`|`needs_follow_up`|`not_applicable`], `confidence`, `evidence_quote`,
  `evidence_span_start`, `evidence_span_end`, `match_quality`
  [`exact`|`normalized`|`ambiguous`|`none`], `source_id`, `extracted_at`, `review_status`
  [`needs_review`|`approved`|`conflict`], `reviewed_value_json`, `reviewed_by`,
  `reviewed_at`, `superseded_by`) — append-only ledger. Current value = latest
  non-superseded row per (`customer_id`, `field_path`).
- **form_drafts**(`id` PK, `customer_id`, `form_type`, `revision`, `projected_json`,
  `status` [`needs_review`|`approved`|`filled`|`superseded`], `approved_by`, `approved_at`,
  `pdf_ref`, `superseded_by_revision`, `created_at`, `updated_at`) — one row **per
  revision**. A `filled` row is **immutable** (audit artifact); re-review creates a new
  revision (see Draft Revisions). Unique current row = highest `revision` per
  (`customer_id`, `form_type`).
- **outbox**(`id` PK, `customer_id`, `form_type`, `draft_revision`, `payload_json` (the
  approved mapping), `status` [`pending`|`processing`|`done`|`dead`], `attempts`,
  `next_attempt_at`, `locked_until`, `created_at`) — durable intent-to-fill; written in the
  same transaction as the approval.
- **customers**(`id` PK, `name`, `dba`, `owner`) — minimal.

The append-only `facts` ledger is what enables audit + correction detection. A simpler
"current-value-only" variant is possible and noted as the MVP fallback.

### Durable processing

The webhook must not hand work to an **in-memory** queue — a process crash between
`202` and extraction would silently drop the transcript. Instead the webhook writes the
`sources` row **and** a `processing_jobs` row in **one transaction**, then returns `202`.
The `processor` is a claimant, exactly like the outbox worker: it leases pending (or
lease-expired) jobs, runs extract→reconcile→project, and marks `done` — or bumps
`attempts`/`next_attempt_at` and dead-letters after N. Nothing lives only in memory, so
recovery after a crash is just "claim the still-pending jobs."

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

`edits` arrive keyed by **ACORD field path** (that's what a reviewer sees). But the
canonical store holds *profile* facts, so the transaction first resolves each edit through
the **reverse binding** `(formType, formFieldPath) → profileFieldPath` before writing.
The transaction does DB-only work and nothing else:

1. **Resolve** each edit's ACORD field path → profile field path via `bindings`. An edit
   with no binding is rejected (surfaces a mapping gap rather than silently dropping).
2. Apply resolved edits → facts get `review_status: "approved"`, `reviewed_value` /
   `presence` set (a human may set `approved_blank`, `not_applicable`, etc.).
3. **Re-project** the form draft JSON from the just-corrected state (persisted JSON and
   the PDF input are therefore guaranteed identical — no drift).
4. `form_drafts.status = approved` on the current revision.
5. Insert an **outbox** row (`pending`) carrying the approved mapping + `draft_revision`.
6. **Commit.**

Bindings are bidirectional and the single source of truth for the DRY overlap: two form
entries pointing at the same `profileFieldPath` *are* the definition of a shared field.
Renderers walk the map forward; `approveForm` walks it in reverse.

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
- **Claim a batch atomically, with lease recovery:** claim rows that are `pending` **or**
  whose lease has expired —
  `UPDATE outbox SET status='processing', locked_until=? WHERE (status='pending' OR
  (status='processing' AND locked_until < now)) AND next_attempt_at <= now LIMIT n`. The
  `locked_until` visibility timeout means a **worker that crashes mid-`fillForm` doesn't
  strand its rows** — the lease expires and another claim reclaims them. (Idempotent
  `fillForm` makes that reclaim safe.) The same primitive backs `processing_jobs`.
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

### Shared-field ripple → new draft revision (filled forms are immutable)

Forms are projections of one profile, so editing a **shared** field (e.g.
`mailing_address`) while approving ACORD 125 changes the value ACORD 126 also draws from.

A `filled` draft is an **immutable audit artifact** — a PDF may already be sitting with a
carrier — so we **never mutate it back to `needs_review`**. Instead, when a shared edit
invalidates a `filled` (or `approved`) ACORD 126, we **create a new `form_drafts` revision**
(`revision + 1`, status `needs_review`, `superseded_by_revision` set on the old row which
stays `filled`/`superseded`). Re-review and any new fill happen on the new revision; the
prior PDF and its approval remain a permanent record. Approval stays per-form; shared edits
ripple as a **new revision to re-review**, not an in-place downgrade.

- A draft that is still `needs_review`/`approved` (never filled) can be updated in place —
  no revision needed until a fill has actually happened.

## Extraction Contract (stack-agnostic)

The LLM fills the **domain model** (`BusinessProfile`), never ACORD field names — form
field names are applied by the renderers, so a form rename is a compile error, not model
drift.

The schema is an **envelope**, not bare values — each field is
`{ value: T | null, presence: "present"|"missing"|"needs_follow_up"|"not_applicable",
confidence: number, evidence: string }`. The model must set `presence` (never emit a bare
`null` whose meaning is ambiguous), and enums (e.g. `entity_type`) constrain it to valid
values. This carries the provenance, confidence, and absence-reason the review step needs.

**The core pattern is identical across libraries:** give the model a schema →
constrained/guided generation for shape → **validate the result at runtime** → hand the app
a **statically-typed object only if it passes**, else retry, else throw.

- **Pydantic AI** — `output_type=Model`; defaults to tool-output (also `NativeOutput` /
  `PromptedOutput`); Pydantic validation; built-in output retries (`ModelRetry`).
- **AI SDK + Zod** — `generateText({ output: Output.object({ schema }) })` (or the
  equivalent `generateObject`); native/tool structured output; Zod validation; throws on
  invalid output.

We hide the difference behind the **`LlmClient` interface** and wrap the call with
**bounded retries** (the AI SDK throws rather than self-retrying on validation failure, so
`LlmClient` owns the retry loop), so app-level behaviour matches Pydantic AI either way —
and the whole design ports to Python/Pydantic AI unchanged (swap Zod→Pydantic,
`Output.object`→`Agent(output_type=…)`).

**Two things this guarantees, and one it does not:**
- Runtime validation makes the static type **sound for shape** — past the single
  parse-at-boundary point, the reconciler, renderers, and `ReviewClient` trust their inputs.
- **Evidence spans are computed in code, not trusted from the model** — the model returns a
  verbatim quote; we locate it in the transcript to get the `[start,end]` span. Plain
  `indexOf` is too brittle (whitespace/case/punctuation normalization, and **repeated
  quotes** that appear more than once), so matching is staged and records `match_quality`:
  **exact** → **normalized** (collapse whitespace, casefold, strip punctuation) →
  otherwise **none**; a normalized match that resolves to **more than one location** is
  **ambiguous**. `ambiguous` and `none` both force the field to `needs_review` (a
  paraphrase or unlocatable quote is a hallucination signal); only `exact`/`normalized`
  single hits get a trusted span.
- **Schema validation proves shape, not truth.** A hallucinated-but-valid `number` still
  passes. Correctness of *values* rests on provenance, evidence spans, confidence, and the
  human approval gate — never on the schema alone.

## Extraction Judgment (from the sample transcript)

The extractor must handle messy speech and prefer flagging over inventing precision:

- Revenue "about 2.5M… north of 2M" → `2500000`, `presence: present`, low confidence, flag *approximate*.
- Payroll "1.7 or 1.8, I'll get back to you" → **blank**, `presence: needs_follow_up`
  (mentioned but deferred — *not* the same as `missing`, and the reviewer sees "customer
  will follow up").
- Two addresses → office `1420 Marine Drive` = premises/location; `PO Box 9102` = `mailing_address`.
- Employees "45 total, ~35 FT, ~10 PT" → FT 35 / PT 10.
- DBA "Coastal Roof & Repair"; entity LLC / sole owner / started 2018; FEIN 12-3456789;
  prior carrier Hartford, expires Sep 1, ~$110k.
- Claims are WC (ladder, $30k) + auto (fence, $15k) → loss-history, **not** 126 GL coverage fields.

## Failure Handling / Production Readiness

- Webhook **persists raw source + `processing_jobs` row in one txn before returning `202`**
  → a transcript survives a process crash; there is no in-memory queue to lose. Recovery is
  just re-claiming still-pending/lease-expired jobs.
- Processing is async and claim-based; the in-process worker can later become SQS/PubSub +
  a fleet without touching the write path (documented seam).
- Both workers retry with per-row backoff; on repeated failure the row dead-letters
  (`status='dead'`). Drafts stay in their prior state; **nothing is auto-submitted** — the
  human gate is the safety net.
- **Lease recovery:** `locked_until` on `processing_jobs` and `outbox` means a crashed
  worker's in-flight rows are reclaimed once the lease expires, never stranded.
- **Idempotency:** sources deduped by id/checksum; reprocessing is safe because facts are
  keyed by `source_id` (upsert, not append-duplicate) and `fillForm` writes a deterministic
  blob key.

## Testing Strategy

- **Unit:** bindings (forward projection + reverse edit-resolution, shared-field overlap),
  renderers, reconciler (corrections, out-of-order, human-edit protection, presence states),
  extractor with mocked `LlmClient`, evidence matcher (exact/normalized/ambiguous/none →
  `needs_review`), `ReviewClient`.
- **Workers / lease:** claim primitive leases pending + reclaims lease-expired rows; retry
  backoff + dead-letter; idempotent re-delivery (same deterministic key → no dup);
  wake-on-commit vs backstop-poll paths. Simulate a mid-flight "crash" (drop the lease) and
  assert reclaim.
- **Durability:** a source + `processing_jobs` row committed together; "restart" (new worker
  instance) re-claims the pending job and completes it.
- **Revisions:** shared edit against a `filled` ACORD 126 creates a new `needs_review`
  revision and leaves the old `filled` row immutable.
- **Integration:** webhook → `processing_jobs` → processor → draft → review → edit →
  `approveForm` (reverse-binding resolution) → outbox → worker → `fillForm` → `filled`,
  mock LLM.
- **Fixtures:** the real `transcripts.json` plus a synthetic correction transcript (revenue
  correction + payroll follow-up filling a `needs_follow_up`) to exercise the multi-transcript path.

## Prototype Build Order

1. Schemas: `BusinessProfile` (Zod), fact shape (value + presence + confidence + evidence + match_quality), form field types.
2. Storage: sqlite repos (sources, processing_jobs, facts, drafts, outbox) + blob store + shared **lease-claim primitive**.
3. `forms/bindings` — the bidirectional `(formType, formFieldPath) ↔ profileFieldPath` map (foundation for renderers *and* approve).
4. Extractor + `LlmClient` interface (+ bounded retry) + mock; evidence matcher (exact/normalized/ambiguous/none).
5. Reconciler (the reducer + conflict detection + presence states).
6. Form renderers (125, 126) driven by bindings — the DRY payoff.
7. Processor as a `processing_jobs` claimant (durable ingest).
8. `fillForm` stub + deterministic blob key.
9. `ReviewClient.approveForm` (reverse-binding resolution; short txn: edits + approval + outbox row) + revision-based shared-field ripple.
10. Outbox worker (wake-on-commit + adaptive backstop poll + lease recovery + per-row retry backoff).
11. Webhook (Fastify) writing source + job in one txn.
12. Tests throughout.

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
