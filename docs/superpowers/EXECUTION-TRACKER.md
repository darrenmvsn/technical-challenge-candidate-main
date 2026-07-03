# ACORD Pipeline — Execution Tracker

**Orchestration:** subagent-driven development. One fresh implementer subagent per ticket
(TDD, from the plan's task brief) → task reviewer (spec + quality) → fix loop → next.
All work lands on branch **`feat/acord-extraction-pipeline`**, one commit-set per ticket.
A single whole-branch review runs after the last ticket.

**Plan (TDD steps + code):** `docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md`
**Board (epics + outcomes):** `docs/superpowers/plans/2026-07-03-acord-delivery-board.md`
**Live status ledger (recovery map):** `.superpowers/sdd/progress.md`

## The north star every ticket points at
Transcript → webhook → LLM draft **with provenance + confidence** → human reviews/corrects/approves
per form → filled PDF **exactly once, durably** → a later correcting transcript self-heals.

## Why sequential (not the board's 3-way parallel)
The board fans E2/E3/E5 across three agents. Subagent-driven development forbids parallel
**implementer** subagents — they share one branch and would collide. So the parallel lanes are
flattened into a dependency-safe numeric order; the parallelism is preserved as *documentation*
of what could run concurrently in a real multi-branch team.

## Ticket ledger

Execution order is plan-Task numeric (1→17) — the plan is authored in dependency order, so this
honors the board's critical path (E1 first; E4 after E2+E3; E6 after E5+E2; E7 last).

| # | Ticket | Epic | Plan Task | Per-PR branch (if split) | PR title | Status |
|---|--------|------|-----------|--------------------------|----------|--------|
| 1 | ACORD-101 | E1 | Task 1 | `feat/acord-101-scaffold-clock-utils` | ACORD-101: scaffold + Clock + id/hash utils | ⬜ pending |
| 2 | ACORD-102 | E1 | Task 2 | `feat/acord-102-domain-schemas` | ACORD-102: BusinessProfile + presence + form field types | ⬜ pending |
| 3 | ACORD-103 | E1 | Task 3 | `feat/acord-103-sqlite-migrations` | ACORD-103: SQLite openDb + full migrations | ⬜ pending |
| 4 | ACORD-201 | E2 | Task 4 | `feat/acord-201-lease-fencing` | ACORD-201: token-fenced lease claim/complete/fail | ⬜ pending |
| 5 | ACORD-202 | E2 | Task 5 | `feat/acord-202-select-current-fact` | ACORD-202: selectCurrentFact selection rule | ⬜ pending |
| 6 | ACORD-203 | E2 | Task 6 | `feat/acord-203-collection-identity` | ACORD-203: idempotent collection item IDs | ⬜ pending |
| 7 | ACORD-501 | E5 | Task 7 | `feat/acord-501-bindings-renderers` | ACORD-501: bindings + flat/nested renderers | ⬜ pending |
| 8 | ACORD-301 | E3 | Task 8 | `feat/acord-301-evidence-matcher` | ACORD-301: locateEvidence provenance matcher | ⬜ pending |
| 9 | ACORD-302 | E3 | Task 9 | `feat/acord-302-llm-extractor` | ACORD-302: LlmClient + Mock + extract() | ⬜ pending |
| 10 | ACORD-401 | E4 | Task 10 | `feat/acord-401-facts-reconciler` | ACORD-401: FactsRepo + reconcile() | ⬜ pending |
| 11 | ACORD-601 | E6 | Task 11 | `feat/acord-601-blob-fillform` | ACORD-601: blobStore + fillForm stub | ⬜ pending |
| 12 | ACORD-602 | E6 | Task 12 | `feat/acord-602-drafts-outbox` | ACORD-602: DraftsRepo + OutboxRepo | ⬜ pending |
| 13 | ACORD-603 | E6 | Task 13 | `feat/acord-603-review-client` | ACORD-603: ReviewClient getDraft/approveForm | ⬜ pending |
| 14 | ACORD-604 | E6 | Task 14 | `feat/acord-604-outbox-worker` | ACORD-604: token-fenced outbox worker | ⬜ pending |
| 15 | ACORD-701 | E7 | Task 15 | `feat/acord-701-sources-jobs-processor` | ACORD-701: durable ingest + processor | ⬜ pending |
| 16 | ACORD-702 | E7 | Task 16 | `feat/acord-702-webhook-server` | ACORD-702: Fastify webhook + DI wiring | ⬜ pending |
| 17 | ACORD-703 | E7 | Task 17 | `feat/acord-703-e2e-correction` | ACORD-703: end-to-end + correction fixture | ⬜ pending |

Status legend: ⬜ pending · 🔨 in progress · 🔬 in review · ✅ complete

## Acceptance gate (== product ships)
ACORD-703's end-to-end test, from a clean DB, drives the north-star sentence green:
ingest transcript 1 → extract → reconcile → project → approve → fill; then ingest a correcting
transcript 2 → re-reconcile (conflict surfaced) → re-approve → re-fill; assert no duplicate fills
and the first fill is immutable.

## Explicitly out of scope (do not claim as delivered)
- Full ACORD field coverage — a **representative** field set only (125 cross-section; 126 shares
  only `employee_count_*`).
- Reviewer-initiated `markNotApplicable` (present→not_applicable flip) — deferred by the plan.
