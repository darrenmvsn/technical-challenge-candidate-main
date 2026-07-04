# ACORD Extraction Pipeline — Delivery Board

> **Role:** PM decomposition of `docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md`
> into epics → tickets for agent developers. One ticket == one plan Task == one PR.
> The plan holds the TDD steps and code; this board holds sequencing, ownership,
> dependencies, and the *done-means-done* outcome for each unit.

## Product end goal (the north star every epic points at)

> A call transcript lands on a webhook. An LLM drafts ACORD field values **with
> provenance and confidence**. A human reviews, corrects, and approves per form.
> Approved data is filled into a PDF **exactly once, durably**, and later transcripts
> that correct the same customer flow through without breaking anything.

Every epic below states how it moves us toward that sentence. An epic is "done"
only when its outcome is demonstrable, not when code merges.

---

## Epic map & critical path

```
E1 Foundations ──┬─► E2 Correctness Primitives ──► E4 Canonical Ledger ──┐
                 ├─► E3 LLM Extraction ───────────────────────────────────┤
                 └─► E5 Form Projection ─────────────────────────────────►├─► E6 Approval → Durable Fill ─► E7 Ingest + E2E
```

- **E1 blocks everything.** Ship it first, no parallelism before it.
- After E1, **E2 / E3 / E5 run in parallel** (three agents) — they only need schema + utils.
- **E4** joins E2's outputs. **E6** joins E5 + E2. **E7** is the integration seam and goes last.
- Sizes: XS <½d · S ½–1d · M 1–3d. No ticket is L/XL — the plan already split them.

---

## EPIC 1 — Foundations & Schema
**Tickets:** ACORD-101…103 (plan Tasks 1–3) · **Size:** M · **Depends on:** —

**Why this exists (→ end goal):** Nothing can be extracted, stored, or filled until
the domain is typed and the store exists. This epic makes "a fact" and "a form field"
real types and gives them a migrated SQLite home. It is pure enablement — zero
user-visible behavior — but every later epic compiles and writes against it.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-101** Scaffold + deterministic utils | Task 1 | `package.json`/`tsconfig`/`vitest` build green; `Clock` (System/Fixed), `newId`/`newLockToken`, `contentHash`/`itemIdFor` unit-tested | S |
| **ACORD-102** Domain schemas | Task 2 | `BusinessProfile` envelope + presence enum (`present/missing/needs_follow_up/not_applicable`), ACORD 125/126 field types, `FormMapping`/`FillMapping` aliases | M |
| **ACORD-103** SQLite connection + migrations | Task 3 | `openDb()`/`migrate()` create every table (sources, processing_jobs, facts, collection_items, drafts, draft_field_bindings, outbox, conflicts); idempotent re-run | S |

**Epic DoD:** `npm run typecheck` clean · migrations create the full schema on a fresh
file and are safe to re-run · util tests green. **Demo:** open a fresh DB, dump the
schema, show the type of one envelope field.

---

## EPIC 2 — Correctness Primitives
**Tickets:** ACORD-201…203 (plan Tasks 4–6) · **Size:** M · **Depends on:** E1

**Why this exists (→ end goal):** This is the epic that earns the words "*exactly once*"
and "*later transcripts that correct the same customer flow through without breaking
anything*." Three isolated, heavily-unit-tested primitives:

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-201** Lease-claim fencing | Task 4 | `claim/complete/fail` guarded by `WHERE id=? AND lock_token=? AND status='processing'`; stale-lease recovery proven by test | M |
| **ACORD-202** `selectCurrentFact` | Task 5 | Pure selection: approval > source_date > confidence > extracted_at — **never** `ORDER BY id`; out-of-order corrections resolve to the right winner | S |
| **ACORD-203** Idempotent collection IDs | Task 6 | `resolveItemId()` = deterministic `sha256(customerId\|collection\|naturalKey)`; same claim twice ⇒ same row, no dupes | S |

**Epic DoD:** each primitive has a red→green test proving the *hard* case (concurrent
double-claim loses safely; a lower-confidence-but-newer correction wins; re-ingested
collection item dedupes). **Demo:** run the three unit suites; walk the reviewer through
the "correction arrives late" test as the proof of the out-of-order guarantee.

---

## EPIC 3 — LLM Extraction
**Tickets:** ACORD-301…302 (plan Tasks 8–9) · **Size:** M · **Depends on:** E1 · **Parallel with E2/E5**

**Why this exists (→ end goal):** This is "*an LLM drafts ACORD field values with
provenance and confidence.*" The LLM sits behind `LlmClient` so the whole pipeline is
testable without a live model, and every drafted value carries an evidence span back
into the transcript — the spine of human trust.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-301** Evidence matcher | Task 8 | `locateEvidence()` maps an extracted value to a transcript char span (provenance); handles fuzz/whitespace | S |
| **ACORD-302** LlmClient + Mock + Extractor | Task 9 | `LlmClient` interface, `AiSdkLlmClient` (AI SDK v6 `Output.object`, **only** file that imports `ai`), `MockLlmClient` from canned fixtures, `extract()` → fact candidates (value + presence + provenance + confidence) | M |

**Epic DoD:** `extract()` on the provided transcript fixture yields candidates with
non-null evidence for present fields and explicit `missing` for absent ones — **using
the mock, no network.** **Demo:** feed the Coastal Roofing transcript, print the
candidate table with evidence spans.

---

## EPIC 4 — Canonical Ledger & Reconciliation
**Tickets:** ACORD-401 (plan Task 10) · **Size:** M · **Depends on:** E1, E2, E3

**Why this exists (→ end goal):** The **single source of truth.** Candidates from many
transcripts collapse into one canonical, append-only ledger: current value per field
(via `selectCurrentFact`), **materialized `missing` rows** so blanks are explicit not
absent, and **visible conflicts** when sources disagree. This is what the human reviews.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-401** Facts repo + reconciler | Task 10 | `FactsRepo` (append-only) + `reconcile()`: candidates → current facts + conflict rows + materialized missing facts; idempotent per source | M |

**Epic DoD:** re-running reconcile with the same source is a no-op; a second source with
a different revenue produces a **conflict row**, not a silent overwrite; every wired
field has a fact row (present or missing). **Demo:** ingest transcript 1 then the
correction fixture; show the ledger before/after and the conflict surfaced.

---

## EPIC 5 — Form Projection (review mapping vs fill mapping)
**Tickets:** ACORD-501 (plan Task 7) · **Size:** M · **Depends on:** E1 (fixtures stand in for E4) · **Parallel with E2/E3**

**Why this exists (→ end goal):** Turns canonical facts into two deliberately different
projections of the same approved truth, so they can never drift:
- **Flat review mapping** (`mailing_address.street`, `claims[0].amount`) + per-draft
  field bindings — **for humans** (display, reverse-edit resolution, draft storage).
- **Nested fill mapping** (`{ mailing_address:{…}, claims:[…] }`) via `toFillMapping` —
  **for the PDF service** (the exact `fill_form` contract).

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-501** Bindings + renderers | Task 7 | `renderForm()` → flat `{ mapping, fieldBindings }`; `reverseResolve()`; `toFillMapping()` → nested fill_form shape; ACORD 125 real cross-section + 126 shared `employee_count_*` | M |

**Epic DoD:** flat↔nested are both pure functions of the same facts (property test:
round-trip a fixture, both shapes derive deterministically); a shared field
(`employee_count`) edited once ripples to both 125 and 126. **Demo:** render one draft,
show the human-facing flat mapping beside the `fill_form`-shaped nested mapping.

---

## EPIC 6 — Approval → Durable Fill
**Tickets:** ACORD-601…604 (plan Tasks 11–14) · **Size:** M-L · **Depends on:** E5, E2, E1

**Why this exists (→ end goal):** The human-in-the-loop **vertical slice** and the
"*exactly once, durably*" promise, end to end: a reviewer loads a draft (with conflicts
+ provenance), corrects, and approves; approval writes a new draft revision **and** an
outbox row in **one short txn**; a token-fenced worker claims the outbox row, calls the
content-addressed `fillForm` stub, and atomically marks the draft `filled` (immutable).

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-601** Blob store + fillForm stub | Task 11 | `blobStore.put/get`; `fillForm(formType, nestedMapping)` writes deterministic key `pdf/{customerId}/{formType}/{contentHash}` | S |
| **ACORD-602** Drafts + Outbox repos | Task 12 | `DraftsRepo` (revisions, projected_json, field bindings) + `OutboxRepo.enqueue` (nested payload, content_hash) | M |
| **ACORD-603** ReviewClient (approve + conflicts) | Task 13 | `getDraft` (flat mapping + provenance + conflicts), reverse-edit resolution, `approveForm` = draft-revision + outbox row in one txn; content_hash over nested = blob key | M |
| **ACORD-604** Outbox worker | Task 14 | Claims outbox with token fencing, calls `fillForm` **outside** any txn, atomic `outbox=done + draft=filled`, retry/backoff; re-approving an already-filled hash is a no-op | M |

**Epic DoD:** approve→fill happens exactly once under a forced double-run of the worker;
a filled draft cannot be mutated; the stored `content_hash` equals the blob key of the
artifact the PDF service actually received (nested). **Demo:** approve the Coastal
Roofing 125, run the worker, show the blob at its content-addressed key; run the worker
again → no second write.

---

## EPIC 7 — Ingest & End-to-End
**Tickets:** ACORD-701…703 (plan Tasks 15–17) · **Size:** M · **Depends on:** ALL

**Why this exists (→ end goal):** Closes the loop and **proves the whole sentence.**
Durable ingest (source + `processing_jobs` row in one txn), the Fastify webhook + DI
wiring, and the correction-fixture E2E that walks transcript → extract → reconcile →
project → approve → fill, then sends a *second, correcting* transcript and asserts the
system self-heals.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-701** Sources/Jobs repos + Processor | Task 15 | Durable ingest (one txn) + processor claims job → extract + reconcile + project | M |
| **ACORD-702** Webhook + server wiring | Task 16 | `POST /webhook/transcript` (Fastify), full DI composition in `server.ts` | S |
| **ACORD-703** End-to-end + correction fixture | Task 17 | E2E: transcript 1 fully processed & filled; correction transcript 2 (revenue + payroll) reconciles, re-projects, re-approves, re-fills; asserts no dupes, conflict surfaced, old fill immutable | M |

**Epic DoD (== product acceptance gate):** one E2E test, run from a clean DB, drives the
north-star sentence end to end and is green. **Demo:** `curl` the webhook twice (original
+ correction), then show the two content-addressed PDFs and the ledger conflict — the
product working through its real seam.

---

## Definition of Done — applies to every ticket

- Code written **test-first** (plan gives the red→green steps), reviewed, merged.
- `npm run typecheck` clean; the ticket's Vitest suite green; no unrelated suite broken.
- No external I/O (`fillForm`, blob writes) inside a DB transaction (global constraint).
- Only `AiSdkLlmClient` imports `ai`; all time via injected `Clock`; all IDs via `newId`/hash.
- One PR per ticket, < ~400 changed lines where practical; commit message references the ticket + plan Task.

## Rollout posture (honest, for this build)

Greenfield service, **no production users, no feature flags** — so the canary/ramp
machinery in the skill's rollout framework does **not** apply and I'm not inventing it.
The **rollout gate is E7's end-to-end test**: the product ships when a clean-DB E2E run
drives ingest→fill→correction green. The plan's declared deferrals (full ACORD field
coverage; reviewer-initiated `markNotApplicable`) are **out of scope for this board** and
must not be claimed as delivered.

## Suggested execution order for agents

1. **One agent** takes **E1** solo (blocking).
2. Fan out **three agents**: E2, E3, E5 in parallel.
3. **E4** starts when E2 lands; **E6** starts when E5 + E2 land.
4. **E7** last, single agent, integrates and owns the acceptance test.
