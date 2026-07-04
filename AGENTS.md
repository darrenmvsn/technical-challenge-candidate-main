# AGENTS.md — Binding rules for every agent working in this repo

This is the ACORD extraction pipeline. **Read this file in full and treat it as binding
before writing or reviewing any code.** It encodes the non-negotiable invariants from the
plan's *Global Constraints* and the delivery board's *Definition of Done*. A violation of
anything under "Non-negotiable invariants" is an **auto-reject** in review — it is a code
smell regardless of whether tests pass.

> **Dispatch note (for the orchestrating run):** `AGENTS.md` is **not** auto-injected into
> Task subagents the way `CLAUDE.md` is into the main session. Every implementer and
> reviewer dispatch prompt must include: *"Read `AGENTS.md` at the repo root and treat it as
> binding."* Hand the reviewer this same file as its rubric so the constraints below are a
> **review gate**, not a suggestion.

Source of truth for detail:
- Plan: `docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md` (TDD steps + code)
- Board: `docs/superpowers/plans/2026-07-03-acord-delivery-board.md` (sequencing + DoD)

---

## Non-negotiable invariants (code smell = auto-reject)

1. **ESM + strict TS.** `"type": "module"`, `strict: true`, Node >= 20. No `any`
   escape hatches in production code. If dynamic JSON traversal needs a heterogeneous
   cursor, isolate it in a tiny helper with typed guards; reviewers should reject broad
   `as any`, `Function`, double-casts through `unknown`, and blanket lint disables. Tests
   may use `any` only for deliberate failure injection/monkeypatching with a same-line
   reason. No `@ts-ignore`/`@ts-expect-error` without a cited reason on the same line.
   `noUncheckedIndexedAccess` is on — respect it.

2. **`ai` isolation.** *Only* `src/extraction/llmClient.ts` (`AiSdkLlmClient`) may import
   `ai`. Anything else importing `ai` is a smell. All LLM access goes through the
   `LlmClient` interface. Use AI SDK **v6** structured output —
   `generateText({ output: Output.object({ schema }) })`, read `result.output`. The
   deprecated `generateObject` is **banned**.

3. **Time only via `Clock`.** No wall-clock reads (`Date.now()`, bare `new Date()`) outside
   `SystemClock` in `src/clock.ts`. Inject `Clock` (`now(): string`) everywhere time is
   read. Date arithmetic/formatting (for leases/backoff such as "now + 30s") must live in
   `src/clock.ts` helpers, not inline worker/repo code. All persisted timestamps are
   ISO-8601 UTC strings.

4. **IDs only via helpers.** Surrogate keys via `newId()`; lock tokens via `newLockToken()`
   (`src/util/id.ts`). Collection-item IDs via `itemIdFor(customerId, collection, naturalKey)`
   = deterministic `sha256(customerId|collection|naturalKey)` truncated (`src/util/hash.ts` /
   `resolveItemId`). No inline `uuid()`/`crypto` calls. **Never** array indices in canonical
   field paths — use `collection.{item_id}.field`, never `collection[0].field`.

5. **No external I/O inside a DB transaction.** `fillForm`, blob writes, and any network call
   never run inside `db.transaction(...)`. better-sqlite3 is synchronous; every write path
   spanning >1 row is wrapped in a single transaction — but I/O stays outside it.

6. **Explicit presence.** Every fact carries `presence ∈ {present, missing, needs_follow_up,
   not_applicable}`. `evidence` is `null` **only** for `missing`. No bare ambiguous nulls.

7. **Fact selection only via `selectCurrentFact`.** Order is approval > source_date >
   confidence > extracted_at (`src/profile/factSelector.ts`). **Never** `ORDER BY id`.

8. **Lease writes are fenced.** Claims use `BEGIN IMMEDIATE` plus a guarded update that
   re-checks claimability (`status='pending'` or expired processing lease, due
   `next_attempt_at`) and stamps a fresh `lock_token` + `locked_until`. `complete()` and
   `fail()` are token-fenced with `WHERE id = ? AND lock_token = ? AND status =
   'processing'`. Generic lease table names must come from a closed internal allowlist
   (`processing_jobs`, `outbox`) — never from request/user input.

9. **Deterministic blob keys.** `fillForm(customerId, formType, nestedMapping, blob)` writes
   `pdf/{customerId}/{formType}/{contentHash}`. It is a stub — no real PDF. The outbox
   `payload_json` is the nested fill-form mapping (not the flat review mapping), and
   `content_hash` must equal the hash component returned by `fillForm` for that exact nested
   payload.

10. **API boundaries validate before use.** Ingress payloads are validated with Zod or a
    Fastify schema before any DB write. No raw `req.body as ...` trust boundary casts in
    route handlers. Bad payloads return 4xx without creating sources, jobs, facts, drafts,
    or outbox rows.

11. **DB invariants are encoded in SQLite where cheap.** Finite states (`presence`,
    `review_status`, job/outbox statuses, conflict status, form type) get `CHECK`
    constraints where practical, and queue/current-read paths get supporting indexes. Do
    not rely only on TypeScript types for persisted data integrity.

12. **Processor persistence is all-or-nothing after the LLM returns.** Collection item
    registry writes, fact inserts, reconciliation/conflict writes, draft projections, field
    bindings, and fenced job completion commit in one transaction. If the completion fence
    fails, none of those domain writes may persist. The only async/network work in the
    processor is the LLM call before that transaction.

---

## Style / structure

- **One responsibility per file.** Follow the plan's `File Structure` map (plan §File
  Structure) **exactly** — do not invent new modules or restructure. Repo-relative imports
  follow existing patterns. Keep files small enough to hold in context.
- **Flat review vs nested fill mapping.** Draft `projected_json`, review fields, edits, and
  `draft_field_bindings` use the flat dotted/bracketed review mapping. Outbox payloads and
  `fillForm` use the nested fill mapping produced by `toFillMapping`. Do not mix the two.
- **TDD.** Failing test first → minimal implementation → green → commit. Tests assert real
  behavior, not mock internals. Pristine test output — no stray warnings or console noise.
- **DRY without premature abstraction. YAGNI.** Build only what the ticket specifies. No
  speculative config, feature flags, or "nice-to-haves."
- **Production error posture.** Expected operational errors (bad webhook payload, duplicate
  ingest, lease loss, retryable worker failure) are handled explicitly and tested. Do not
  swallow errors silently; do not add console noise in tests; do not expose stack traces from
  HTTP handlers.

## Per-ticket Definition of Done (every PR)

- Code written test-first; reviewed; merged. `npm run typecheck` clean.
- The ticket's Vitest suite green; no unrelated suite broken.
- No external I/O inside a DB transaction (invariant #5).
- Only `AiSdkLlmClient` imports `ai`; all time via injected `Clock`/`clock.ts` date helpers;
  all IDs via `newId`/`newLockToken`/hash helpers.
- API payloads validated at the boundary; DB status enums constrained; lease/fill/processor
  atomicity tests cover stale-token, lost-lease, and retry paths where the ticket touches
  those surfaces.
- One PR per ticket, < ~400 changed lines where practical; commit message references the
  ticket (`ACORD-NNN`) + the plan Task.

Commands: `npm test` (vitest run) · `npm run typecheck` (tsc --noEmit) · `npm run dev`.

## Scope guardrails (do not "fix" an intentional omission)

- **Representative field set only — do NOT claim full ACORD coverage.** ACORD 125 is wired
  with a real cross-section (identity, revenue, employees, mailing-address leaves, one
  `claims` collection). ACORD 126 shares **only** `employee_count_*` with 125 — enough to
  prove the DRY overlap and cross-form ripple. 126-specific fields (GL premises, hazard
  classifications, products schedule), `annual_payroll`, `prior_carrier_*`, and the
  `locations`/`prior_carriers`/`hazard_classifications`/`additional_insureds`/
  `products_schedule` collections are **intentionally not bound**. A field in the envelope
  but absent from a form's bindings is extracted and stored but never projected — that is
  **intentional, not a bug**.
- **`markNotApplicable` (present → not_applicable flip) is deferred — out of scope, not a
  bug.** `markApproved` sets `review_status` + `reviewed_value_json` only; it does not mutate
  `presence`. Approving an already-`missing`/`needs_follow_up` field with a null value
  (`approved_blank`) **is** in scope and tested.

Extending coverage is mechanical (add rows to `STATIC_BINDINGS`/`COLLECTION_BINDINGS`, add
fields to `ExtractionEnvelope`) and needs no architecture changes — but it is **not this
build's job unless the ticket says so.**
