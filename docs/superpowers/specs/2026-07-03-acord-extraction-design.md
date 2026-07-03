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
  reference impl uses the Vercel AI SDK **v6** structured-output API —
  `generateText({ output: Output.object({ schema }) })` (the older `generateObject` is
  deprecated in current AI SDK docs) — swappable for Vertex/Bedrock. The interface is
  mockable so the whole pipeline is testable without a live model.
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
  // evidence is null for a truly missing field — there is no quote to point at
  source_id: "src_001",
  review_status: "needs_review"   // -> "approved" once a human confirms/edits
}
```

"Facts" is not a separate subsystem — it is the field shape of the canonical profile.
`evidence` is **nullable**: a `missing` field has no quote, so its evidence is `null`
rather than an empty object (a `needs_follow_up` field may keep the deferral quote, e.g.
"I'll get back to you").

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

### Collection identity (repeated objects need stable IDs)

`field_path` is fine for scalars (`annual_gross_revenue`) and fixed nested objects
(`mailing_address.street`). But **array-index paths are unstable** for the repeated
collections — `claims`, `locations`, `prior_carriers`, `hazard_classifications`,
`additional_insureds`, `products_schedule`. `claims[0].amount` silently rebinds if a later
extraction reorders the list or inserts an item, which would corrupt reconciliation and
scramble a human's per-item edits.

So each repeated item gets a **stable `item_id`** and facts key on it:
`claims.{item_id}.amount`, not `claims[0].amount`. Items are **matched across transcripts by
a natural key** (a claim by `year + type`, a prior carrier by `carrier_name`, a location by
normalized address) so a correction in call #2 updates the *same* claim rather than
appending a duplicate. No confident natural-key match → new item, surfaced for review
(merge/split is a human decision, never a silent guess). Reconciliation and the presence
axis then operate per item-field, exactly as for scalars.

**`item_id` must be idempotent across reprocessing.** Extraction is at-least-once (a
`processing_jobs` retry re-runs the same source), so generating a fresh random id per run
would fork one claim into duplicates. Two mechanisms, used together:

- **Deterministic id** = a hash of (`customer_id`, `collection`, `natural_key`). Re-running
  the same source yields the *same* id, so re-extraction is idempotent by construction.
- **`collection_items` registry** persists `natural_key → item_id`. First sighting inserts;
  later sightings with the **same** natural key look it up and reuse the id — so identity is
  stable for a well-chosen key (a claim's `year+type`, a carrier's name).

Reprocessing the same transcript therefore never creates duplicate items or orphan facts.

**When a natural key genuinely changes** (a corrected claim year, a re-typed carrier name),
the new key misses the registry and a **new item** is minted and **surfaced for review** —
we do **not** silently auto-merge it onto the old item, because guessing that two
differently-keyed items are "the same" is exactly the merge/split judgment that belongs to a
human. The registry guarantees *stability*, not *fuzzy re-identification*.

## Components (clean boundaries)

| Module | Responsibility | Depends on |
|---|---|---|
| `ingest/webhook` | Validate payload, dedupe by source id, **in one txn** persist raw source + insert `processing_jobs` row, return 202 | sources + jobs repos |
| `storage/sources` | Append-only raw-source store (source of truth) | sqlite |
| `extraction/extractor` | transcript(s) → Zod-validated facts w/ provenance + confidence | `LlmClient` |
| `profile/reconciler` | Merge candidates via `selectCurrentFact`; **materialize `presence: missing` rows for every form-bound field**; write `conflicts` rows when a newer candidate disagrees with an approved fact | facts repo, factSelector, bindings |
| `forms/bindings` | Static `(formType, formFieldPath) ↔ profileFieldPath` map for scalar/fixed fields | — |
| `forms/renderers` | Pure `profile → { mapping, fieldBindings }` projections for 125 & 126; emit the concrete **per-draft** binding rows (incl. array `claims[i] → claims.{item_id}`) alongside the mapping | bindings |
| `forms/fillForm` | Stub: `(formType, mapping) → bytes`; writes to blob store at a deterministic key | blob store |
| `review/ReviewClient` | The TS "UI stand-in": list/get drafts, get field + provenance, `listUnresolvedConflicts`, `resolveConflict`, `approveForm(edits?)` (one short txn) | facts + drafts + outbox + conflicts repos, bindings |
| `worker/processor` | Claims `processing_jobs` (lease): extract → reconcile → re-project drafts → needs_review; retry/dead-letter | jobs repo, extractor, reconciler |
| `worker/outboxWorker` | Claims `outbox` (lease): wake-on-commit + adaptive backstop poll; calls `fillForm`, `approved→filled`, per-row retry backoff | outbox repo, fillForm |
| `worker/leaseClaimer` | Shared claim primitive: atomically lease pending/expired rows with `locked_until` + fresh `lock_token`; reclaim on crash; token-fenced completion so a stale worker can't finish reclaimed work | sqlite |
| `profile/factSelector` | Pure `selectCurrentFact(candidates)` — approval > source_date > confidence > extracted_at | — |
| `profile/collectionIdentity` | Assign/match stable `item_id` for repeated objects (claims, locations, carriers) across transcripts by natural key | — |

The LLM sits behind `LlmClient` so extraction is deterministic and testable with canned structured responses.

## Data Model (SQLite)

- **sources**(`id` PK, `customer_id`, `type`, `source_date`, `received_at`, `raw_json`,
  `checksum`, `status`) — append-only; source of truth.
- **processing_jobs**(`id` PK, `source_id`, `customer_id`, `status`
  [`pending`|`processing`|`done`|`dead`], `attempts`, `next_attempt_at`, `locked_until`,
  `lock_token`, `locked_by`, `created_at`) — durable ingest work-queue; written **in the
  same txn** as the source so a process crash can never lose a transcript (see Durable
  Processing). `lock_token`/`locked_by` fence stale workers (see Lease Fencing).
- **facts**(`id` PK, `customer_id`, `field_path` (stable — `claims.{item_id}.amount`, never
  `claims[0].amount`), `value_json`, `presence`
  [`present`|`missing`|`needs_follow_up`|`not_applicable`], `confidence`, `evidence_quote`
  (nullable), `evidence_span_start`, `evidence_span_end`, `match_quality`
  [`exact`|`normalized`|`ambiguous`|`none`], `source_id`, `source_date`, `extracted_at`,
  `review_status` [`needs_review`|`approved`|`conflict`], `reviewed_value_json`,
  `reviewed_by`, `reviewed_at`, `superseded_by`) — append-only ledger. The **current fact**
  per (`customer_id`, `field_path`) is chosen by an explicit selection rule
  (see Current-Fact Selection), **not** simply the latest-inserted row.
- **form_drafts**(`id` PK, `customer_id`, `form_type`, `revision`, `projected_json`,
  `status` [`needs_review`|`approved`|`filled`], `approved_by`, `approved_at`, `pdf_ref`,
  `superseded_by_revision` (nullable), `created_at`, `updated_at`) — one row **per
  revision**. `status` is the row's own lifecycle and is **not** overwritten when a newer
  revision appears; supersession is recorded **only** by setting `superseded_by_revision`
  (so a `filled` row stays `filled` forever — an accurate audit record — even after it's
  superseded). Current row = highest `revision` with `superseded_by_revision IS NULL` per
  (`customer_id`, `form_type`).
- **draft_field_bindings**(`draft_id` FK, `form_field_path` (concrete, e.g.
  `claims[0].amount`), `profile_field_path` (stable, e.g. `claims.{item_id}.amount`)) —
  **per-draft** resolved bindings; PK (`draft_id`, `form_field_path`). See Per-Draft
  Bindings.
- **collection_items**(`id` PK = deterministic `item_id`, `customer_id`, `collection`
  [`claims`|`locations`|`prior_carriers`|…], `natural_key`, `created_at`) — registry that
  makes `item_id` **idempotent across reprocessing** (see Collection Identity).
- **outbox**(`id` PK, `customer_id`, `form_type`, `draft_revision`, `payload_json` (the
  approved mapping), `content_hash`, `status`
  [`pending`|`processing`|`done`|`dead`|`cancelled`], `attempts`, `next_attempt_at`,
  `locked_until`, `lock_token`, `locked_by`, `created_at`) — durable intent-to-fill; written
  in the same transaction as the approval. A re-approval **cancels** any still-`pending` row
  for the same (`customer_id`, `form_type`) rather than editing it (see Re-Approval).
- **conflicts**(`id` PK, `customer_id`, `field_path`, `current_fact_id` (the
  still-current, usually human-approved fact), `conflicting_fact_id` (the newer candidate
  that disagrees), `status` [`unresolved`|`resolved`], `resolved_by`, `resolved_at`,
  `created_at`) — explicit conflict ledger (see Visible Conflicts).
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

Each transcript contributes fact candidates keyed by (stable) `field_path` + `source_id`,
stamped with the **transcript's own `date`** (not arrival time).

### Current-Fact Selection

The current value per field is **not** "the latest inserted row." It's an explicit,
deterministic `selectCurrentFact(candidates)` that sorts by, in order:

1. **Approval state.** A human-`approved` fact outranks any machine candidate — human
   override always wins.
2. **`source_date`** (newest first) — so a correction in a later call supersedes an earlier
   value, and a late-arriving *older* transcript can't clobber newer info (arrival order is
   irrelevant).
3. **`confidence`** (highest) as the tie-breaker when dates are equal.
4. **`extracted_at`** only as a final, stable deterministic tie-breaker.

Making this a named pure function (not an `ORDER BY id LIMIT 1`) means selection is
unit-testable in isolation and identical everywhere it's read.

### Visible Conflicts (not silent overwrite)

A newer machine extraction that disagrees with an **already-approved** value does **not**
win rule 2 — approval outranks it, so the approved fact *stays current*. The danger: if the
only signal were the current value, the disagreement would be **invisible** — the reviewer
would never learn the latest call contradicts their earlier sign-off.

So a disagreement writes a row to the **`conflicts`** ledger (`current_fact_id` = the
approved fact, `conflicting_fact_id` = the newer candidate, `status = unresolved`). The
newer candidate is retained (not superseded), and `ReviewClient.listUnresolvedConflicts(customerId)`
surfaces every open conflict **independently of which value is currently winning**. A human
resolves it — keep the approved value, or promote the new one (a fresh approval, which then
flows through re-projection + a new revision) — flipping the conflict to `resolved`. This
read model is what guarantees corrections are never quietly dropped just because a human had
already approved.

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

1. **Resolve** each edit's ACORD field path → profile field path: array-element paths via
   the draft's **persisted `draft_field_bindings`**, scalars via the static map. An edit
   that resolves to nothing is rejected (surfaces a mapping gap rather than silently
   dropping).
2. Apply resolved edits → those facts get `reviewed_value` / `presence` set.
3. **Approve every field the form uses, not only the edited ones.** Approving a form is a
   human signing off on the *whole rendered form*, so every profile fact reachable from this
   form's bindings is marked `review_status: "approved"` (edited or not). Otherwise an
   untouched machine value would ride onto a carrier-bound PDF without anyone having
   approved it — and a later extraction could still silently flip it. **This requires a fact
   row to exist for every bound field, including blanks** — so the reconciler materializes a
   `presence: missing` (value `null`, `evidence: null`) row for any bound field a transcript
   never mentioned. Approve-all then marks these `approved` while non-present, i.e.
   `approved_blank`; without the materialized rows there'd be nothing to mark. (A reviewer
   *explicitly* flipping a present field to `not_applicable` is a deferred write path — see
   the plan's Explicit Scope / Deferrals; `approved_blank` sign-off on genuinely-blank fields
   is built.)
4. **Re-project** the form draft JSON from the just-approved state (persisted JSON and the
   PDF input are therefore guaranteed identical — no drift), and **persist the fresh
   `draft_field_bindings`** for this revision.
5. **Approve the draft, superseding any outstanding fill.** *First approval (no `pending`/
   `processing`/`filled` predecessor):* set `form_drafts.status = approved` on the current
   revision. *Re-approval (an outbox row is `pending`/`processing`, or the draft is
   `filled`):* `cancel` the outstanding outbox row, set `superseded_by_revision` on the prior
   draft, and create a **new revision** with `status = approved` — never edit the outstanding
   row in place (see Re-Approval).
6. Insert a fresh **outbox** row (`pending`) carrying the approved mapping + `draft_revision`
   + `content_hash`.
7. **Commit.**

Bindings are the single source of truth for the DRY overlap: two form entries pointing at
the same `profileFieldPath` *are* the definition of a shared field. Renderers walk them
forward; `approveForm` walks them in reverse.

### Per-Draft Bindings (static map isn't enough for arrays)

The static map works for scalars and fixed nested objects (`policyholder_first_name`,
`mailing_address.street`), where the ACORD path is constant. It **cannot** cover repeated
collections: the profile holds `claims.{item_id}.amount`, but ACORD renders positionally as
`claims[0].amount`, `claims[1].amount`, … — and which `item_id` sits at index `0` depends on
how many claims exist and their order **at render time**. A static table can't know that.

So **at render time the renderer emits the concrete binding rows** and we persist them in
**`draft_field_bindings`** for that draft revision: `claims[0].amount → claims.{item_id}.amount`.
When a reviewer edits `claims[0].amount`, `approveForm` reverse-resolves through the
**persisted per-draft binding** (not the static map) to reach the right item's fact — so an
edit lands on the intended claim even if a later re-extraction would reorder the array.
Scalars still use the static map; only array-element paths need the per-draft rows.

### Re-Approval (a pending fill already exists)

If the form is re-approved while its previous fill is `pending`, already leased
(`processing`), or already `filled`, we must not mutate the outstanding work in place — that
would race the worker or corrupt an immutable artifact. Instead:

- **Pending fill:** `cancel` the row and enqueue a new one on a new revision.
- **Processing fill (already leased by a worker):** also `cancel` it — cancelling covers
  `processing`, not just `pending`. Because the worker's completion write is guarded by
  `status='processing' AND lock_token=?` (see Lease Fencing), flipping the row to
  `cancelled` makes that in-flight worker's completion **no-op**, so a superseded fill can
  never mark itself `done`. Exactly one fill (the newest revision's) wins.
- **Filled already:** leave the `filled` row + PDF immutable; the re-approval lands on a new
  revision with its own outbox row (consistent with the shared-field ripple rule).

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
- **Claim a batch atomically, with lease recovery + fencing:** each claim stamps a fresh
  **`lock_token`** (and `locked_by`) and a `locked_until`, claiming rows that are `pending`
  **or** lease-expired —
  `UPDATE outbox SET status='processing', locked_until=?, lock_token=?, locked_by=? WHERE
  (status='pending' OR (status='processing' AND locked_until < now)) AND next_attempt_at <=
  now LIMIT n`. The `locked_until` timeout means a **worker that crashes mid-`fillForm`
  doesn't strand its rows** — the lease expires and another claim reclaims them.
- **Lease fencing (an expired-but-alive slow worker, or a cancelled row):** reclaim alone
  isn't enough — a slow worker whose lease expired could wake up and complete *stale* work
  over the row a new worker now owns, and a re-approval may have `cancelled` the row out from
  under it. So every completion/failure write is **guarded by both token and status**:
  `UPDATE outbox SET status='done' WHERE id=? AND lock_token=? AND status='processing'`. If
  the row was reclaimed (token changed) **or** cancelled (status no longer `processing`), the
  stale worker's write **no-ops** — only the current lease holder of a still-`processing` row
  can finish it. (Idempotent `fillForm` + deterministic key means even a duplicated blob
  write is harmless; fencing keeps the *state machine* correct.) The same primitive backs
  `processing_jobs`. The **claim itself** starts with `BEGIN IMMEDIATE` (write lock taken up
  front) and each row's UPDATE re-checks the claimable predicate, so two workers can never
  lease the same row; only rows whose guarded UPDATE wins are returned.

  The fenced completion (`outbox → done`) and the resulting `draft → filled` write commit in
  **one transaction**: a crash between them would otherwise strand the draft `approved`
  forever (the `done` row is never retried). Symmetrically, the `processor` commits its
  fact/draft persistence **and** its job completion in a single transaction — so a reclaim
  after a crash can never re-run projection over a draft a human approved in the interim.
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
(`revision + 1`, status `needs_review`) and set `superseded_by_revision` on the old row.
The old row **keeps its own status** (`filled` stays `filled`) — supersession is recorded
solely via `superseded_by_revision`, so the audit trail shows exactly what was filled and
that it was later superseded. Re-review and any new fill happen on the new revision; the
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
confidence: number, evidence: string | null }`. The model must set `presence` (never emit a
bare `null` whose meaning is ambiguous), `evidence` is `null` for a `missing` field, and
enums (e.g. `entity_type`) constrain it to valid values. This carries the provenance,
confidence, and absence-reason the review step needs.

**The core pattern is identical across libraries:** give the model a schema →
constrained/guided generation for shape → **validate the result at runtime** → hand the app
a **statically-typed object only if it passes**, else retry, else throw.

- **Pydantic AI** — `output_type=Model`; defaults to tool-output (also `NativeOutput` /
  `PromptedOutput`); Pydantic validation; built-in output retries (`ModelRetry`).
- **AI SDK + Zod** — `generateText({ output: Output.object({ schema }) })` (the older
  `generateObject` is deprecated); native/tool structured output; Zod validation; throws on
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
  renderers, `selectCurrentFact` (approval > source_date > confidence, out-of-order arrival,
  approved-beats-newer-machine → `conflict`), collection identity (same claim matched across
  transcripts by natural key; unmatched → new item), reconciler (presence states), extractor
  with mocked `LlmClient`, evidence matcher (exact/normalized/ambiguous/none → `needs_review`;
  missing → null evidence), `ReviewClient`.
- **Per-draft bindings (arrays):** edit `claims[0].amount` on a draft, then a re-extraction
  reorders the array → assert the edit still resolved to the original claim's `item_id` via
  the persisted `draft_field_bindings`.
- **Idempotent item_id:** reprocess the *same* source twice → no duplicate collection items,
  same `item_id` (deterministic id + `collection_items` registry). A **re-seen identical**
  natural key resolves to the existing item; a **changed** natural key mints a new item
  surfaced for human merge (we do not fuzzy-re-identify).
- **Approval semantics:** `approveForm` marks **every** form-bound fact approved (incl.
  materialized `presence: missing` rows → `approved_blank`); a subsequent machine extraction
  cannot silently flip an approved field.
- **Visible conflicts:** newer candidate disagrees with an approved fact → approved value
  stays current **and** `listUnresolvedConflicts` returns it; `resolveConflict` clears it.
- **Re-approval:** re-approving cancels a `pending` **or `processing`** outbox row + opens a
  new revision (no in-place edit); re-approving a `filled` form lands on a new revision while
  the old row **stays `filled`** with `superseded_by_revision` set.
- **Workers / lease + fencing:** claim leases pending + reclaims lease-expired rows; retry
  backoff + dead-letter; idempotent re-delivery (same deterministic key → no dup);
  wake-on-commit vs backstop-poll. Simulate a mid-flight "crash" → assert reclaim; simulate
  an **expired slow worker** and a **cancelled row** completing with stale `lock_token` /
  non-`processing` status → assert both writes no-op.
- **Durability:** a source + `processing_jobs` row committed together; "restart" (new worker
  instance) re-claims the pending job and completes it.
- **Integration:** webhook → `processing_jobs` → processor → draft → review → edit →
  `approveForm` (reverse-binding resolution) → outbox → worker → `fillForm` → `filled`,
  mock LLM.
- **Fixtures:** the real `transcripts.json` plus a synthetic correction transcript (revenue
  correction + payroll follow-up filling a `needs_follow_up`) to exercise the multi-transcript path.

## Prototype Build Order

1. Schemas: `BusinessProfile` (Zod), fact shape (value + presence + nullable evidence + confidence + match_quality + stable `field_path`), form field types.
2. Storage: sqlite repos (sources, processing_jobs, facts, collection_items, drafts, draft_field_bindings, outbox, conflicts) + blob store + shared **lease-claim primitive with token fencing**.
3. `forms/bindings` — static scalar map + renderer-emitted **per-draft** bindings for array elements.
4. `selectCurrentFact` + `collectionIdentity` (deterministic `item_id` + registry) — pure, unit-tested first.
5. Extractor + `LlmClient` interface (+ bounded retry) + mock; evidence matcher (exact/normalized/ambiguous/none; missing → null).
6. Reconciler (candidates → current facts via `selectCurrentFact`; materialize `missing` rows for bound fields; write `conflicts`).
7. Form renderers (125, 126) → `{ mapping, fieldBindings }`, driven by bindings — the DRY payoff.
8. Processor as a token-fenced `processing_jobs` claimant (durable ingest).
9. `fillForm` stub + deterministic blob key.
10. `ReviewClient` — `approveForm` (per-draft reverse-resolution; approve **all** form-bound facts; supersede pending/processing fill; persist bindings; short txn) + `listUnresolvedConflicts`/`resolveConflict`.
11. Outbox worker (wake-on-commit + adaptive backstop poll + lease recovery + token+status fencing + per-row retry backoff).
12. Webhook (Fastify) writing source + job in one txn.
13. Tests throughout.

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
