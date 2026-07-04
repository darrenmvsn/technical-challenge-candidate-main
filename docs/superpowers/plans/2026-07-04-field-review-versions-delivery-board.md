# Field Review Versions — Delivery Board

> **Role:** PM decomposition of `docs/superpowers/plans/2026-07-04-field-review-versions.md`
> into epics → tickets for agent developers. One ticket normally maps to one plan Task; the
> schema/type rename pair (**ACORD-801 + ACORD-802**) is the deliberate exception and ships as
> one atomic PR because neither half is independently typecheckable without temporary aliases.
> The plan holds the TDD steps and code; this board holds sequencing, ownership,
> dependencies, and the *done-means-done* outcome for each unit.
>
> **Lane position:** This is the **next lane after** `2026-07-04-customer-identity-resolution.md`
> (landed: sources now attach to a stable `customer_id` before any customer-scoped row is
> written — AGENTS.md #13). This lane assumes that prerequisite is complete and does not
> re-open it.

## Product end goal (the north star every epic points at)

> Every value on an ACORD form traces to **either** a machine-extracted candidate (with
> provenance + confidence) **or** an immutable human review decision (who, what action, when).
> The current value is **computed** from the selected machine candidate plus the *latest* human
> decision — **never copied into the candidate row**. The read model keeps both pointers:
> `selected_candidate` for newest machine evidence and `value_candidate` for the evidence behind
> the displayed value. That keeps the human-decision history complete and append-only, makes new
> machine evidence surface as a **conflict** instead of a silent overwrite, and keeps every
> already-filled PDF **reproducible** from its snapshot.

For an insurance/ACORD product this is the *system-of-record* property: "who approved this
number, and why" must always be answerable, and a later transcript must never quietly rewrite
a value a human already signed off. Every epic below states how it moves us toward that
sentence. An epic is "done" only when its outcome is demonstrable, not when code merges.

---

## ⚠️ Reviewer note — read before reviewing ACORD-801…806

This lane **rewrites AGENTS.md invariant #7**. Today the repo (and AGENTS.md #7) say the
current value comes from `selectCurrentFact`, with human approvals stored **on the fact row**
(`review_status`, `reviewed_value_json`). This lane deletes that entanglement: machine evidence
lives in `extracted_field_candidates`, human decisions live in immutable `field_review_versions`,
and the current value is *computed* by `currentProfileMap`.

**Consequence:** tickets 801–806 will look like they *violate* the invariant #7 wording that is
still in `AGENTS.md` (they remove `selectCurrentFact`, `reviewed_value_json`, `FactsRepo`). That
is **the sanctioned change, not a defect.** Judge 801–806 against **this plan's** model. The
AGENTS.md #7 rewrite is the *last* ticket (**ACORD-807**) so the invariant is updated in the same
branch it stops being true — but that means reviewers of the earlier tickets must not
auto-reject on the stale rubric. All other invariants (#1 strict TS, #3 Clock, #4 IDs, #5/#12
txn atomicity + no I/O in txn, #6 evidence-null-only-for-missing, #10 Zod at boundary, #11 CHECK
constraints, #13 identity) remain **fully binding** for every ticket.

---

## Epic map & critical path

```
A (801+802 atomic schema/type/repo rename)
        │
        ▼
B (803 review-versions repo)
        │
        ▼
C (804 projection) ─► D (805 conflicts) ─► E (806 review client) ─► F (807 cleanup + AGENTS.md #7)
```

- **A (801+802) blocks everything.** Ship the schema/type/repo rename together, or keep explicit temporary compatibility aliases.
- **B (803)** follows A because its tests use `ExtractedFieldCandidatesRepo`.
- **C (804)** joins the candidate repo + review-version repo (it overlays reviews on candidates).
- **D (805)** needs C (its contrast test asserts on `currentProfileMap`) + the candidate/review repos.
- **E (806)** needs D (it resolves the conflicts D detects) + C + the review repo.
- **F (807)** is the integration/honesty seam — stale-name sweep, AGENTS.md #7, plan amendment — and goes **last**.
- Sizes: XS <½d · S ½–1d · M 1–3d. ACORD-806 is upper-M, but still scoped to one vertical slice.
- **Greenfield branch refactor:** no back-compat data migration from `facts`; the schema and code are replaced before the branch lands.

---

## EPIC A — Atomic Rename & Candidate Store
**Tickets:** ACORD-801 + ACORD-802 (plan Tasks 1–2) · **Size:** M · **Depends on:** identity lane (landed)

**Why this exists (→ end goal):** Establishes the two-layer separation at the storage level —
machine evidence vs. human decisions — that the whole north star rests on. Renames the
ambiguous `facts`/`conflicts` into `extracted_field_candidates`/`field_conflicts`, strips the
human-review columns off candidate rows, and adds `field_review_versions` with **monotonic
per-field versions** and CHECK-constrained enums. Pure enablement, zero behavior — but every
later ticket compiles and writes against it. ACORD-801 and ACORD-802 are a single atomic PR:
801 alone changes names while the code still imports old names; 802 completes the rename.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-801** Schema + migration rename + types | Task 1 | Migration replaces `facts`→`extracted_field_candidates`, `conflicts`→`field_conflicts`, adds `field_review_versions` (`UNIQUE(customer_id, field_path, version)`, `action`/`presence` CHECKs, latest-version index), adds unresolved-conflict unique index; candidate row loses `review_status`/`reviewed_value_json`/`reviewed_by`/`reviewed_at`; types `ExtractedFieldCandidate`, `FieldReviewVersion`, `CurrentFieldValue`, `ReviewAction` added | M |
| **ACORD-802** Candidate repo + pure `selectCurrentCandidate` | Task 2 | Rename `FactsRepo`→`ExtractedFieldCandidatesRepo` (insert drops review columns; `currentCandidateMap`, `byField`, `supersede`, `get`); `selectCurrentCandidate` = pure `source_date > confidence > extracted_at`, skips superseded; delete `facts.ts`/`factSelector.ts` | M |

**Epic DoD:** `npm run typecheck` clean after both 801 and 802 · migration tests prove the three tables exist, the four
review columns are **gone** from candidates, and a duplicate `(customer, field, version)` throws ·
migration idempotent on re-run (AGENTS.md #11). Conflict tests prove duplicate unresolved conflicts
for the same candidate are DB-rejected. **Demo:** fresh DB → dump schema → show
`field_review_versions` with its unique version constraint, `field_conflicts` with the unresolved
unique index, and the candidate table with no review columns.

---

## EPIC B — Review-Version Store
**Tickets:** ACORD-803 (plan Task 3) · **Size:** S · **Depends on:** A

**Why this exists (→ end goal):** Adds the append-only human-decision store on top of the candidate
store from Epic A. The review-versions repo gives monotonic per-field versioning, candidate-pointer
integrity, and a `latest` lookup: the spine of the audit trail.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-803** `FieldReviewVersionsRepo` | Task 3 | `insertVersion` validates candidate exists and belongs to the same `(customer_id, field_path)`, assigns next per-`(customer, field)` version; `latestByField`, `latestMap`, `get`; IDs via `newId()` (AGENTS.md #4); timestamps passed in, no wall-clock (AGENTS.md #3) | S |

**Epic DoD:** review repo hands out versions 1, 2, 3… per field, rejects missing, wrong-customer,
or wrong-field candidate IDs, and `latestMap` returns only the active version per field. **Demo:**
insert two candidates + two review versions for one field → show `latestByField` and one rejected
invalid candidate pointer in one breath.

---

## EPIC C — Current Profile Projection
**Tickets:** ACORD-804 (plan Task 4) · **Size:** M · **Depends on:** A + B

**Why this exists (→ end goal):** The **"computed, not copied"** rule made real. `currentProfileMap`
returns both the `selected_candidate` (latest machine evidence) and `value_candidate` (the candidate
whose evidence supports the value currently displayed). A human-approved value wins over a newer
machine candidate, and provenance for the displayed value still points at the candidate that
actually supports that value; with **no** review, both candidates are the same selected machine row
and the field is marked `needs_review`. This is the single read model the whole product renders
every form from, so review-mapping and fill-mapping can never drift from the same source.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-804** `currentProfileMap` + renderer switch | Task 4 | `currentProfileMap(candidates, reviews, customerId)` → `Map<field, CurrentFieldValue>` (`selected_candidate`, `value_candidate`, review overlay, `review_status`, `approved_blank`); `renderForm` consumes `CurrentFieldValue` (flat review mapping + `toFillMapping` unchanged) | M |

**Epic DoD:** a field with an approved *older* value and a newer machine candidate → current shows
the **approved** value with `review_status='approved'`, `selected_candidate.id` points at the newer
machine row, and `value_candidate.id` points at the reviewed row so displayed provenance is not
misattributed; a field with no review → machine value, `needs_review`, both candidate pointers equal.
**Demo:** render one draft, show the current value is the human's while the conflict/new-evidence
awareness still names the newer machine candidate.

---

## EPIC D — Conflict Detection Against Review Versions
**Tickets:** ACORD-805 (plan Task 5) · **Size:** M · **Depends on:** C, B

**Why this exists (→ end goal):** The guarantee that **new evidence surfaces as a conflict, never a
silent overwrite.** The reconciler opens a `field_conflict` **only** when a newer machine candidate
disagrees with the *latest human review* — and stays silent when no human has decided yet (the
machine value just becomes current). This is precisely what protects a signed-off value from being
quietly rewritten by a later transcript.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-805** Reconciler + `FieldConflictsRepo` vs reviews | Task 5 | Rename `ConflictsRepo`→`FieldConflictsRepo` (`*_candidate_id` columns, `resolved_by_review_version_id`, `existsOpen`, `listUnresolved`, `resolve`); inserts are idempotent against the unresolved-conflict unique index; reconciler opens a conflict iff selected machine candidate is newer **and** value-differs from `latestByField`; still materializes missing candidates; delete `conflicts.ts` | M |

**Epic DoD:** newer disagreeing candidate + an existing approved review → **exactly one** conflict
(`current_candidate_id`=reviewed, `conflicting_candidate_id`=new); the **contrast** case — same two
candidates, **no** review — opens **zero** conflicts and the newer machine value is current.
**Demo:** approve a revenue value, ingest a correcting transcript, show the conflict row appear
(and show the no-review path stays silent).

---

## EPIC E — Human Approvals as Review Versions
**Tickets:** ACORD-806 (plan Task 6) · **Size:** M · **Depends on:** D, C, B

**Why this exists (→ end goal):** The **vertical slice** of the human-decision layer and the
auditable "who approved what, when, why." `approveForm` now writes immutable `field_review_versions`
and **never mutates candidates**; an edit that matches a conflicting candidate creates an
`accepted_conflict` version pointing at that newer candidate **and** resolves the conflict via
`resolved_by_review_version_id`; drafts and outbox stay **immutable snapshots** so a previously filled
PDF still reproduces after newer versions land (AGENTS.md #5/#12 — version writes + conflict resolve +
draft revision + outbox row in one txn, `fillForm`/blob writes outside it).

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-806** ReviewClient writes versions + resolves conflicts | Task 6 | `ReviewDeps` swaps `facts`→`candidates` + adds `reviewVersions`; `approveForm` inserts versions (`approved`/`edited`/`accepted_conflict`/`approved_blank`) using `value_candidate` for ordinary approvals/edits and the conflicting candidate for accepted conflicts, resolves matching conflicts, recomputes profile, re-renders; `getDraft` provenance carries `review_status`/`approved_blank`/`review_version` from `value_candidate`; processor deps take `reviewVersions`; wire all construction sites | M |

**Epic DoD:** approving creates version rows with candidates **untouched** (no `reviewed_value_json`
anywhere); editing a conflicted field to the conflicting value → an `accepted_conflict` version whose
`candidate_id` is the conflicting candidate **and** the conflict flips to `resolved` with
`resolved_by_review_version_id` set; existing review-client behaviors remain covered (shared-field
ripple, re-approving filled forms, pending outbox cancellation, `approved_blank`); outbox row still
enqueued `pending`; integration + processor suites green. **Demo:** approve → version 1; ingest correction → conflict; accept correction →
version 2 (`accepted_conflict`), conflict resolved, and **both** the original and corrected fills
still reproduce from their snapshots.

---

## EPIC F — Rename Cleanup, Invariant #7 & Docs
**Tickets:** ACORD-807 (plan Task 7) · **Size:** M · **Depends on:** ALL

**Why this exists (→ end goal):** Closes the branch **honestly** so future agents don't reintroduce
the entanglement this lane removed. No stale `facts`/`FactsRepo`/`selectCurrentFact`/
`reviewed_value_json` in production code, **AGENTS.md invariant #7 rewritten** from "fact selection via
`selectCurrentFact`" to "current profile is **computed, not copied**," and the extraction-pipeline plan
amended with the review-version model. The binding rubric must tell the truth about the schema on the
day the schema changes.

| Ticket | Plan Task | Deliverable | Size |
|---|---|---|---|
| **ACORD-807** Stale-name sweep + AGENTS.md #7 + plan amendment | Task 7 | `rg` sweep leaves no production `FactsRepo`/`Fact`/`factSelector`/`current_fact_id`/`reviewed_value_json`; AGENTS.md #7 replaced with the computed-profile wording + table-name updates; amendment block added to `2026-07-03-acord-extraction-pipeline.md`; full guardrail grep block from the plan clean | M |

**Epic DoD (== lane acceptance gate):** full `npm test` **and** `npm run typecheck` green from a clean
state; `git diff --check` clean; guardrail greps clean — `ai` imports only in
`src/extraction/llmClient.ts`, no `Date.now()`/`new Date()`/`toISOString()` outside `src/clock.ts`, no
`as any`/`@ts-ignore`/`@ts-expect-error` in production, no `fillForm`/blob write inside a DB
transaction. **Demo:** run the plan's Task 7 Step 5 verification block and show every grep empty and
both suites green.

---

## Definition of Done — applies to every ticket

- Code written **test-first** (the plan gives the red→green steps), reviewed, merged. `npm run typecheck` clean at the PR boundary.
- The ticket's Vitest suite green; **no unrelated suite broken** (rename touches many call sites — run the full suite).
- No external I/O (`fillForm`, blob writes) inside a DB transaction; multi-row writes wrapped in one txn (AGENTS.md #5/#12).
- All time via injected `Clock`/`clock.ts` helpers (#3); all IDs via `newId`/`newLockToken`/hash helpers (#4); `evidence`/blank rules per #6.
- Finite states (`presence`, `action`, conflict `status`) carry SQLite CHECK constraints (#11).
- Every dispatch (implementer **and** reviewer) includes: *"Read `AGENTS.md` at the repo root and treat it as binding"* — **plus the ⚠️ Reviewer note above for 801–806**, so the in-flight #7 rewrite is not mis-flagged.
- One PR per ticket, < ~400 changed lines where practical, except the explicit ACORD-801+802 atomic rename PR; commit message references the ticket (`ACORD-NNN`) + the plan Task.

## Scope guardrails (do not "fix" an intentional omission)

- **Greenfield branch refactor — no back-compat migration from `facts`.** Replace the schema and code; do not build a production data migration.
- **Out of scope for this lane (from the plan):** a UI route for conflict acceptance; full ACORD field expansion beyond the existing representative set; reviewer-set `not_applicable` (present→not_applicable flip) — still deferred, `approved_blank` remains the only blank-approval path.
- The representative field set and the ACORD 125/126 overlap are inherited from the pipeline lane and are **not** widened here.

## Rollout posture (honest, for this build)

Greenfield service, **no production users, no feature flags** — the canary/ramp machinery in the
spec-to-repo rollout framework does **not** apply and is not invented. The **rollout gate is E-F's
acceptance**: the lane ships when a clean `npm test` + `npm run typecheck` pass with the
`accepted_conflict` correction path (E-806) proven green and the stale-name/guardrail sweep (F-807)
clean.

## Suggested execution order for agents

1. **One agent** takes **ACORD-801 + ACORD-802** together (blocking atomic schema/type/repo rename).
2. **ACORD-803** when the atomic rename lands.
3. **ACORD-804** when 803 lands.
4. **ACORD-805** when 804 lands.
5. **ACORD-806** when 805 lands.
6. **ACORD-807** last, single agent — owns the stale-name sweep, the AGENTS.md #7 rewrite, and the final green gate.
