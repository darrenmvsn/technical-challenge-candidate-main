# Field Review Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Complete `2026-07-04-customer-identity-resolution.md` first. This plan assumes
sources are already attached to a stable `customer_id` before field candidates are inserted.

**Goal:** Rename ambiguous `facts` into extracted field candidates and add immutable field review versions so current canonical state is computed by joining machine evidence with the latest human-approved version.

**Architecture:** `extracted_field_candidates` stores immutable machine/source evidence only. `field_review_versions` stores immutable human decisions with monotonically increasing per-field versions; the active reviewed value is the latest version. `form_drafts` and `outbox` remain snapshots so historical approvals and filled PDFs are reproducible even after newer review versions are inserted.

**Tech Stack:** TypeScript ESM, strict TS, better-sqlite3, Zod, Vitest.

---

## Prerequisite

Complete `docs/superpowers/plans/2026-07-04-customer-identity-resolution.md` before executing
this plan. The actual upstream transcript payload does not include `customer_id`; this plan
assumes raw sources have already been resolved to a stable customer before field candidates are
inserted.

---

## Scope

This is a greenfield branch refactor. Do not build a backwards-compatible production data migration from `facts`; replace the schema and code before landing the branch.

In this plan:

- Rename `facts` table to `extracted_field_candidates`.
- Rename `conflicts` table to `field_conflicts`.
- Add `field_review_versions`.
- Remove human-review columns from extracted candidates.
- Compute current profile values by overlaying latest review versions on selected candidates.
- Keep form drafts and outbox payloads as immutable snapshots.

Out of scope:

- A UI route for conflict acceptance.
- Full ACORD field expansion beyond the existing representative field set.
- Reviewer-set `not_applicable` if it was already deferred by the plan.

---

## File Structure

Modify:

- `src/schema/profile.ts`
  - Rename `Fact` to `ExtractedFieldCandidate`.
  - Add `FieldReviewVersion`, `ReviewAction`, `CurrentFieldValue`.
- `src/db/migrations.ts`
  - Replace `facts` with `extracted_field_candidates`.
  - Replace `conflicts` with `field_conflicts`.
  - Add `field_review_versions`.
- `src/db/repos/facts.ts`
  - Rename file to `src/db/repos/extractedFieldCandidates.ts`.
  - Rename `FactsRepo` to `ExtractedFieldCandidatesRepo`.
- `src/db/repos/conflicts.ts`
  - Rename file to `src/db/repos/fieldConflicts.ts`.
  - Rename `ConflictsRepo` to `FieldConflictsRepo`.
  - Rename columns from `*_fact_id` to `*_candidate_id`.
- `src/profile/factSelector.ts`
  - Rename file to `src/profile/candidateSelector.ts`.
  - Replace approval-aware selection with pure machine candidate selection.
- `src/forms/renderers.ts`
  - Render `CurrentFieldValue`, not raw candidates.
- `src/extraction/extractor.ts`
  - Emit `ExtractedFieldCandidate`.
- `src/profile/reconciler.ts`
  - Detect conflicts against latest field review versions.
- `src/review/reviewClient.ts`
  - Write `field_review_versions`, not review columns on candidates.
  - Resolve matching conflicts to the review version that accepted the correction.
- `src/worker/processor.ts`, `src/server.ts`, tests
  - Wire renamed repos and current profile projection.

Create:

- `src/db/repos/fieldReviewVersions.ts`
- `src/profile/currentProfile.ts`
- `tests/db/fieldReviewVersions.test.ts`
- `tests/profile/currentProfile.test.ts`

Delete after renaming:

- `src/db/repos/facts.ts`
- `src/db/repos/conflicts.ts`
- `src/profile/factSelector.ts`

---

## Target Data Model

Use this DDL in `src/db/migrations.ts` for the new tables.

```ts
CREATE TABLE IF NOT EXISTS extracted_field_candidates (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value_json TEXT,
  presence TEXT NOT NULL
    CHECK (presence IN ('present','missing','needs_follow_up','not_applicable')),
  confidence REAL NOT NULL,
  evidence_quote TEXT,
  evidence_span_start INTEGER,
  evidence_span_end INTEGER,
  match_quality TEXT NOT NULL
    CHECK (match_quality IN ('exact','normalized','ambiguous','none')),
  source_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_current
  ON extracted_field_candidates(customer_id, field_path, superseded_by);

CREATE TABLE IF NOT EXISTS field_review_versions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  version INTEGER NOT NULL,
  candidate_id TEXT NOT NULL,
  value_json TEXT,
  presence TEXT NOT NULL
    CHECK (presence IN ('present','missing','needs_follow_up','not_applicable')),
  action TEXT NOT NULL
    CHECK (action IN ('approved','edited','accepted_conflict','approved_blank')),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  UNIQUE(customer_id, field_path, version)
);
CREATE INDEX IF NOT EXISTS idx_review_versions_latest
  ON field_review_versions(customer_id, field_path, version DESC);

CREATE TABLE IF NOT EXISTS field_conflicts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  current_candidate_id TEXT NOT NULL,
  conflicting_candidate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved','resolved')),
  resolved_by_review_version_id TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_conflicts_customer_status
  ON field_conflicts(customer_id, status);
```

Remove these columns from the old candidate row shape:

```text
review_status
reviewed_value_json
reviewed_by
reviewed_at
```

---

## Task 1: Schema and Migration Rename

**Files:**

- Modify: `src/schema/profile.ts`
- Modify: `src/db/migrations.ts`
- Test: `tests/db/migrations.test.ts`
- Test: `tests/schema/profile.test.ts`

- [ ] **Step 1: Write failing migration tests**

Add tests asserting the new tables exist and old ambiguous tables/columns do not.

```ts
it('creates extracted candidates, review versions, and field conflicts tables', () => {
  const db = openDb()
  migrate(db)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((r: any) => r.name) // deliberate sqlite metadata test shape
  expect(names).toContain('extracted_field_candidates')
  expect(names).toContain('field_review_versions')
  expect(names).toContain('field_conflicts')
})

it('does not keep human review columns on extracted candidates', () => {
  const db = openDb()
  migrate(db)
  const columns = db.prepare("PRAGMA table_info(extracted_field_candidates)")
    .all().map((r: any) => r.name) // deliberate sqlite metadata test shape
  expect(columns).not.toContain('review_status')
  expect(columns).not.toContain('reviewed_value_json')
  expect(columns).not.toContain('reviewed_by')
  expect(columns).not.toContain('reviewed_at')
})

it('field_review_versions enforces per-field monotonically unique versions', () => {
  const db = openDb()
  migrate(db)
  db.prepare(`INSERT INTO extracted_field_candidates
    (id, customer_id, field_path, value_json, presence, confidence, match_quality, source_id, source_date, extracted_at)
    VALUES ('cand1', 'c1', 'annual_gross_revenue', '2500000', 'present', 1, 'exact', 's1', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`).run()
  db.prepare(`INSERT INTO field_review_versions
    (id, customer_id, field_path, version, candidate_id, value_json, presence, action, reviewed_by, reviewed_at)
    VALUES ('rv1', 'c1', 'annual_gross_revenue', 1, 'cand1', '2500000', 'present', 'approved', 'sarah', '2025-01-02T00:00:00Z')`).run()
  expect(() => db.prepare(`INSERT INTO field_review_versions
    (id, customer_id, field_path, version, candidate_id, value_json, presence, action, reviewed_by, reviewed_at)
    VALUES ('rv2', 'c1', 'annual_gross_revenue', 1, 'cand1', '2500000', 'present', 'approved', 'sarah', '2025-01-02T00:00:00Z')`).run()).toThrow()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/db/migrations.test.ts tests/schema/profile.test.ts
```

Expected: FAIL because the new tables/types do not exist.

- [ ] **Step 3: Update profile types**

In `src/schema/profile.ts`, replace `Fact` with:

```ts
export type ReviewAction = 'approved' | 'edited' | 'accepted_conflict' | 'approved_blank'

export interface ExtractedFieldCandidate {
  id: string
  customer_id: string
  field_path: string
  value_json: string | null
  presence: Presence
  confidence: number
  evidence_quote: string | null
  evidence_span_start: number | null
  evidence_span_end: number | null
  match_quality: MatchQuality
  source_id: string
  source_date: string
  extracted_at: string
  superseded_by: string | null
}

export interface FieldReviewVersion {
  id: string
  customer_id: string
  field_path: string
  version: number
  candidate_id: string
  value_json: string | null
  presence: Presence
  action: ReviewAction
  reviewed_by: string
  reviewed_at: string
}

export interface CurrentFieldValue {
  field_path: string
  candidate: ExtractedFieldCandidate
  review: FieldReviewVersion | null
  value_json: string | null
  presence: Presence
  review_status: 'needs_review' | 'approved'
  approved_blank: boolean
}
```

- [ ] **Step 4: Update DDL**

In `src/db/migrations.ts`, replace the `facts` and `conflicts` DDL with the DDL in "Target Data Model". Update the table list in migration tests from:

```ts
['sources','processing_jobs','facts','collection_items','form_drafts','draft_field_bindings','outbox','conflicts','customers']
```

to:

```ts
['sources','processing_jobs','extracted_field_candidates','field_review_versions','collection_items','form_drafts','draft_field_bindings','outbox','field_conflicts','customers']
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/db/migrations.test.ts tests/schema/profile.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema/profile.ts src/db/migrations.ts tests/db/migrations.test.ts tests/schema/profile.test.ts
git commit -m "feat(ACORD): rename facts schema and add field review versions"
```

---

## Task 2: Candidate Repo and Pure Candidate Selection

**Files:**

- Rename: `src/db/repos/facts.ts` -> `src/db/repos/extractedFieldCandidates.ts`
- Rename: `src/profile/factSelector.ts` -> `src/profile/candidateSelector.ts`
- Test: rename/update `tests/profile/factSelector.test.ts` -> `tests/profile/candidateSelector.test.ts`
- Test: update repo tests that reference `FactsRepo`

- [ ] **Step 1: Write failing selector tests**

Create `tests/profile/candidateSelector.test.ts`.

```ts
import { describe, it, expect } from 'vitest'
import { selectCurrentCandidate } from '../../src/profile/candidateSelector.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const base: ExtractedFieldCandidate = {
  id: 'x',
  customer_id: 'c1',
  field_path: 'annual_gross_revenue',
  value_json: '1',
  presence: 'present',
  confidence: 0.5,
  evidence_quote: null,
  evidence_span_start: null,
  evidence_span_end: null,
  match_quality: 'none',
  source_id: 's',
  source_date: '2025-01-01T00:00:00Z',
  extracted_at: '2025-01-01T00:00:00Z',
  superseded_by: null,
}
const c = (o: Partial<ExtractedFieldCandidate>): ExtractedFieldCandidate => ({ ...base, ...o })

describe('selectCurrentCandidate', () => {
  it('selects newest source_date before confidence', () => {
    const olderHighConfidence = c({ id: 'old', source_date: '2025-01-01T00:00:00Z', confidence: 0.99 })
    const newerLowConfidence = c({ id: 'new', source_date: '2025-02-01T00:00:00Z', confidence: 0.2 })
    expect(selectCurrentCandidate([olderHighConfidence, newerLowConfidence])!.id).toBe('new')
  })

  it('breaks source_date ties by confidence then extracted_at', () => {
    const a = c({ id: 'a', confidence: 0.8, extracted_at: '2025-01-01T00:00:00Z' })
    const b = c({ id: 'b', confidence: 0.8, extracted_at: '2025-01-02T00:00:00Z' })
    expect(selectCurrentCandidate([a, b])!.id).toBe('b')
  })

  it('ignores superseded candidates', () => {
    const dead = c({ id: 'dead', source_date: '2025-03-01T00:00:00Z', superseded_by: 'replacement' })
    const live = c({ id: 'live', source_date: '2025-01-01T00:00:00Z' })
    expect(selectCurrentCandidate([dead, live])!.id).toBe('live')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run:

```bash
npx vitest run tests/profile/candidateSelector.test.ts
```

Expected: FAIL because `candidateSelector.js` does not exist.

- [ ] **Step 3: Implement candidate selector**

Create `src/profile/candidateSelector.ts`.

```ts
import type { ExtractedFieldCandidate } from '../schema/profile.js'

/** Machine-candidate selection only: source_date > confidence > extracted_at. Human approvals live in field_review_versions. */
export function selectCurrentCandidate(candidates: ExtractedFieldCandidate[]): ExtractedFieldCandidate | undefined {
  const live = candidates.filter(c => c.superseded_by === null)
  if (live.length === 0) return undefined
  return [...live].sort((a, b) =>
    b.source_date.localeCompare(a.source_date) ||
    b.confidence - a.confidence ||
    b.extracted_at.localeCompare(a.extracted_at)
  )[0]
}
```

- [ ] **Step 4: Implement extracted candidates repo**

Rename `FactsRepo` to `ExtractedFieldCandidatesRepo`. The class must expose:

```ts
export class ExtractedFieldCandidatesRepo {
  constructor(private db: DB) {}
  insertMany(candidates: ExtractedFieldCandidate[]): void
  byField(customerId: string, fieldPath: string): ExtractedFieldCandidate[]
  allFieldPaths(customerId: string): string[]
  currentCandidateMap(customerId: string): Map<string, ExtractedFieldCandidate>
  supersede(id: string, by: string): void
  get(id: string): ExtractedFieldCandidate | undefined
}
```

Use `INSERT OR IGNORE INTO extracted_field_candidates` and remove all review columns from the insert statement.

- [ ] **Step 5: Replace imports**

Run:

```bash
rg -n "FactsRepo|Fact|factSelector|facts" src tests
```

Replace production usages with:

```ts
ExtractedFieldCandidatesRepo
ExtractedFieldCandidate
candidateSelector
extracted_field_candidates
```

Do not blindly replace prose in historical docs unless it describes the live schema.

- [ ] **Step 6: Run selector and repo-adjacent tests**

Run:

```bash
npx vitest run tests/profile/candidateSelector.test.ts tests/extraction/extractor.test.ts tests/profile/reconciler.test.ts
npm run typecheck
```

Expected: PASS after import updates.

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/extractedFieldCandidates.ts src/profile/candidateSelector.ts src/extraction src/profile tests
git rm src/db/repos/facts.ts src/profile/factSelector.ts tests/profile/factSelector.test.ts
git commit -m "refactor(ACORD): rename facts to extracted field candidates"
```

---

## Task 3: Field Review Versions Repo

**Files:**

- Create: `src/db/repos/fieldReviewVersions.ts`
- Test: `tests/db/fieldReviewVersions.test.ts`

- [ ] **Step 1: Write failing repo tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const candidate = (id: string, value: unknown): ExtractedFieldCandidate => ({
  id,
  customer_id: 'c1',
  field_path: 'annual_gross_revenue',
  value_json: JSON.stringify(value),
  presence: 'present',
  confidence: 0.9,
  evidence_quote: 'q',
  evidence_span_start: 0,
  evidence_span_end: 1,
  match_quality: 'exact',
  source_id: id,
  source_date: '2025-03-12T00:00:00Z',
  extracted_at: '2025-03-12T00:00:00Z',
  superseded_by: null,
})

describe('FieldReviewVersionsRepo', () => {
  let db: DB
  let candidates: ExtractedFieldCandidatesRepo
  let reviews: FieldReviewVersionsRepo

  beforeEach(() => {
    db = openDb()
    migrate(db)
    candidates = new ExtractedFieldCandidatesRepo(db)
    reviews = new FieldReviewVersionsRepo(db)
    candidates.insertMany([candidate('cand1', 2500000), candidate('cand2', 2800000)])
  })

  it('inserts monotonically increasing versions per customer and field', () => {
    const v1 = reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'cand1',
      valueJson: '2500000',
      presence: 'present',
      action: 'approved',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-16T00:00:00Z',
    })
    const v2 = reviews.insertVersion({
      customerId: 'c1',
      fieldPath: 'annual_gross_revenue',
      candidateId: 'cand2',
      valueJson: '2800000',
      presence: 'present',
      action: 'accepted_conflict',
      reviewedBy: 'sarah',
      reviewedAt: '2025-03-17T00:00:00Z',
    })
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(reviews.latestByField('c1', 'annual_gross_revenue')!.id).toBe(v2.id)
  })

  it('latestMap returns only the active review version per field', () => {
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand1', valueJson: '2500000', presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z' })
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand2', valueJson: '2800000', presence: 'present', action: 'edited', reviewedBy: 'sarah', reviewedAt: '2025-03-17T00:00:00Z' })
    expect(reviews.latestMap('c1').get('annual_gross_revenue')!.value_json).toBe('2800000')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/db/fieldReviewVersions.test.ts
```

Expected: FAIL because repo does not exist.

- [ ] **Step 3: Implement repo**

```ts
import type { DB } from '../sqlite.js'
import type { FieldReviewVersion, Presence, ReviewAction } from '../../schema/profile.js'
import { newId } from '../../util/id.js'

export interface InsertReviewVersion {
  customerId: string
  fieldPath: string
  candidateId: string
  valueJson: string | null
  presence: Presence
  action: ReviewAction
  reviewedBy: string
  reviewedAt: string
}

export class FieldReviewVersionsRepo {
  constructor(private db: DB) {}

  insertVersion(args: InsertReviewVersion): FieldReviewVersion {
    const next = this.nextVersion(args.customerId, args.fieldPath)
    const id = newId()
    this.db.prepare(`INSERT INTO field_review_versions
      (id, customer_id, field_path, version, candidate_id, value_json, presence, action, reviewed_by, reviewed_at)
      VALUES (@id, @customerId, @fieldPath, @version, @candidateId, @valueJson, @presence, @action, @reviewedBy, @reviewedAt)`)
      .run({ id, version: next, ...args })
    return this.get(id)!
  }

  latestByField(customerId: string, fieldPath: string): FieldReviewVersion | undefined {
    return this.db.prepare(`SELECT * FROM field_review_versions
      WHERE customer_id=? AND field_path=?
      ORDER BY version DESC LIMIT 1`).get(customerId, fieldPath) as FieldReviewVersion | undefined
  }

  latestMap(customerId: string): Map<string, FieldReviewVersion> {
    const rows = this.db.prepare(`SELECT * FROM field_review_versions
      WHERE customer_id=?
      ORDER BY field_path ASC, version DESC`).all(customerId) as FieldReviewVersion[]
    const out = new Map<string, FieldReviewVersion>()
    for (const row of rows) if (!out.has(row.field_path)) out.set(row.field_path, row)
    return out
  }

  get(id: string): FieldReviewVersion | undefined {
    return this.db.prepare('SELECT * FROM field_review_versions WHERE id=?').get(id) as FieldReviewVersion | undefined
  }

  private nextVersion(customerId: string, fieldPath: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 n
      FROM field_review_versions WHERE customer_id=? AND field_path=?`)
      .get(customerId, fieldPath) as { n: number }
    return row.n
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/db/fieldReviewVersions.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/fieldReviewVersions.ts tests/db/fieldReviewVersions.test.ts
git commit -m "feat(ACORD): add immutable field review versions repo"
```

---

## Task 4: Current Profile Projection

**Files:**

- Create: `src/profile/currentProfile.ts`
- Modify: `src/forms/renderers.ts`
- Test: `tests/profile/currentProfile.test.ts`
- Test: `tests/forms/renderers.test.ts`

- [ ] **Step 1: Write failing current profile tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { ExtractedFieldCandidatesRepo } from '../../src/db/repos/extractedFieldCandidates.js'
import { FieldReviewVersionsRepo } from '../../src/db/repos/fieldReviewVersions.js'
import { currentProfileMap } from '../../src/profile/currentProfile.js'
import type { ExtractedFieldCandidate } from '../../src/schema/profile.js'

const candidate = (id: string, sourceDate: string, value: unknown): ExtractedFieldCandidate => ({
  id,
  customer_id: 'c1',
  field_path: 'annual_gross_revenue',
  value_json: JSON.stringify(value),
  presence: 'present',
  confidence: 0.9,
  evidence_quote: 'q',
  evidence_span_start: 0,
  evidence_span_end: 1,
  match_quality: 'exact',
  source_id: id,
  source_date: sourceDate,
  extracted_at: sourceDate,
  superseded_by: null,
})

describe('currentProfileMap', () => {
  let db: DB
  let candidates: ExtractedFieldCandidatesRepo
  let reviews: FieldReviewVersionsRepo

  beforeEach(() => {
    db = openDb()
    migrate(db)
    candidates = new ExtractedFieldCandidatesRepo(db)
    reviews = new FieldReviewVersionsRepo(db)
  })

  it('uses the latest review version over a newer machine candidate', () => {
    candidates.insertMany([
      candidate('cand-old', '2025-03-12T00:00:00Z', 2500000),
      candidate('cand-new', '2025-03-15T00:00:00Z', 2800000),
    ])
    reviews.insertVersion({ customerId: 'c1', fieldPath: 'annual_gross_revenue', candidateId: 'cand-old', valueJson: '2500000', presence: 'present', action: 'approved', reviewedBy: 'sarah', reviewedAt: '2025-03-16T00:00:00Z' })
    const current = currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!
    expect(current.value_json).toBe('2500000')
    expect(current.review_status).toBe('approved')
    expect(current.review!.candidate_id).toBe('cand-old')
    expect(current.candidate.id).toBe('cand-new')
  })

  it('falls back to the selected machine candidate when no review exists', () => {
    candidates.insertMany([
      candidate('cand-old', '2025-03-12T00:00:00Z', 2500000),
      candidate('cand-new', '2025-03-15T00:00:00Z', 2800000),
    ])
    const current = currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!
    expect(current.value_json).toBe('2800000')
    expect(current.review_status).toBe('needs_review')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/profile/currentProfile.test.ts
```

Expected: FAIL because `currentProfile.js` does not exist.

- [ ] **Step 3: Implement `currentProfileMap`**

```ts
import type { ExtractedFieldCandidatesRepo } from '../db/repos/extractedFieldCandidates.js'
import type { FieldReviewVersionsRepo } from '../db/repos/fieldReviewVersions.js'
import type { CurrentFieldValue } from '../schema/profile.js'

export function currentProfileMap(
  candidates: ExtractedFieldCandidatesRepo,
  reviews: FieldReviewVersionsRepo,
  customerId: string,
): Map<string, CurrentFieldValue> {
  const candidateMap = candidates.currentCandidateMap(customerId)
  const reviewMap = reviews.latestMap(customerId)
  const out = new Map<string, CurrentFieldValue>()

  for (const [fieldPath, candidate] of candidateMap) {
    const review = reviewMap.get(fieldPath) ?? null
    const value_json = review ? review.value_json : candidate.value_json
    const presence = review ? review.presence : candidate.presence
    out.set(fieldPath, {
      field_path: fieldPath,
      candidate,
      review,
      value_json,
      presence,
      review_status: review ? 'approved' : 'needs_review',
      approved_blank: review !== null && presence !== 'present',
    })
  }

  return out
}
```

- [ ] **Step 4: Update renderers**

Change `renderForm` to accept:

```ts
export function renderForm(formType: FormType, fields: Map<string, CurrentFieldValue>): RenderResult
```

Replace the old value helper with:

```ts
const val = (f: CurrentFieldValue | undefined): string | number | boolean | null => {
  if (!f) return null
  return f.value_json === null ? null : JSON.parse(f.value_json)
}
```

Keep flat review mapping and `toFillMapping` behavior unchanged.

- [ ] **Step 5: Run projection/render tests**

```bash
npx vitest run tests/profile/currentProfile.test.ts tests/forms/renderers.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/profile/currentProfile.ts src/forms/renderers.ts tests/profile/currentProfile.test.ts tests/forms/renderers.test.ts
git commit -m "feat(ACORD): compute current profile from candidates and review versions"
```

---

## Task 5: Reconciler and Conflict Detection Against Review Versions

**Files:**

- Modify: `src/profile/reconciler.ts`
- Modify/Rename: `src/db/repos/fieldConflicts.ts`
- Test: `tests/profile/reconciler.test.ts`

- [ ] **Step 1: Write failing conflict tests**

Add a test showing a newer machine candidate creates a conflict only when it disagrees with the latest review version.

```ts
it('opens a field conflict when a newer candidate disagrees with the latest review version', () => {
  candidates.insertMany([
    candidate({ id: 'old', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
    candidate({ id: 'new', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
  ])
  reviews.insertVersion({
    customerId: 'c1',
    fieldPath: 'annual_gross_revenue',
    candidateId: 'old',
    valueJson: '2500000',
    presence: 'present',
    action: 'approved',
    reviewedBy: 'sarah',
    reviewedAt: '2025-03-16T00:00:00Z',
  })

  reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })

  const open = conflicts.listUnresolved('c1')
  expect(open).toHaveLength(1)
  expect(open[0]!.current_candidate_id).toBe('old')
  expect(open[0]!.conflicting_candidate_id).toBe('new')
})
```

Add a contrast test:

```ts
it('does not open a conflict when no human review version exists', () => {
  candidates.insertMany([
    candidate({ id: 'old', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
    candidate({ id: 'new', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
  ])
  reconcile({ db, candidates, reviews, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
  expect(conflicts.listUnresolved('c1')).toHaveLength(0)
  expect(currentProfileMap(candidates, reviews, 'c1').get('annual_gross_revenue')!.value_json).toBe('2800000')
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/profile/reconciler.test.ts
```

Expected: FAIL because `reconcile` still reads candidate review columns.

- [ ] **Step 3: Update conflicts repo**

`FieldConflictsRepo` must expose:

```ts
export interface FieldConflictRow {
  id: string
  customer_id: string
  field_path: string
  current_candidate_id: string
  conflicting_candidate_id: string
  status: 'unresolved' | 'resolved'
  resolved_by_review_version_id: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

export class FieldConflictsRepo {
  existsOpen(customerId: string, conflictingCandidateId: string): boolean
  insert(customerId: string, fieldPath: string, currentCandidateId: string, conflictingCandidateId: string, now: string): void
  listUnresolved(customerId: string): FieldConflictRow[]
  get(id: string): FieldConflictRow | undefined
  resolve(id: string, reviewVersionId: string, by: string, at: string): void
}
```

- [ ] **Step 4: Update reconciler**

Reconciler logic:

```ts
for each fieldPath:
  const latestReview = reviews.latestByField(customerId, fieldPath)
  if no latestReview: continue
  const reviewedCandidate = candidates.get(latestReview.candidate_id)
  const selectedMachine = selectCurrentCandidate(candidates.byField(customerId, fieldPath))
  if selectedMachine is missing: continue
  if selectedMachine.id === latestReview.candidate_id: continue
  if selectedMachine.source_date <= reviewedCandidate.source_date: continue
  if selectedMachine.value_json === latestReview.value_json: continue
  conflicts.insert(customerId, fieldPath, latestReview.candidate_id, selectedMachine.id, now)
```

Keep missing candidate materialization, but insert missing rows into `extracted_field_candidates`.

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/profile/reconciler.test.ts tests/profile/currentProfile.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/profile/reconciler.ts src/db/repos/fieldConflicts.ts tests/profile/reconciler.test.ts
git rm src/db/repos/conflicts.ts
git commit -m "feat(ACORD): reconcile conflicts against latest review versions"
```

---

## Task 6: ReviewClient Writes Versions, Not Candidate Mutations

**Files:**

- Modify: `src/review/reviewClient.ts`
- Modify: `src/server.ts`
- Modify: `src/worker/processor.ts`
- Test: `tests/review/reviewClient.test.ts`
- Test: `tests/integration/pipeline.test.ts`

- [ ] **Step 1: Write failing review tests**

Add tests for first approval and accepted correction.

```ts
it('approving a form creates field review versions and does not mutate extracted candidates', () => {
  const res = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
  const review = reviewVersions.latestByField('c1', 'annual_gross_revenue')!
  expect(review.version).toBe(1)
  expect(review.value_json).toBe('2500000')
  expect(review.action).toBe('approved')
  expect(candidates.get(review.candidate_id)!.value_json).toBe('2500000')
  expect(candidates.get(review.candidate_id)).not.toHaveProperty('reviewed_value_json')
  expect(outbox.get(res.outboxId)!.status).toBe('pending')
})

it('editing a conflicted field to the conflicting value creates an accepted_conflict version and resolves the conflict', () => {
  const conflict = conflicts.listUnresolved('c1').find(c => c.field_path === 'annual_gross_revenue')!
  rc.approveForm('c1', 'acord_125', { edits: { annual_gross_revenue: 2800000 }, by: 'sarah' })
  const latest = reviewVersions.latestByField('c1', 'annual_gross_revenue')!
  expect(latest.action).toBe('accepted_conflict')
  expect(latest.candidate_id).toBe(conflict.conflicting_candidate_id)
  expect(conflicts.get(conflict.id)!.status).toBe('resolved')
  expect(conflicts.get(conflict.id)!.resolved_by_review_version_id).toBe(latest.id)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/review/reviewClient.test.ts
```

Expected: FAIL because ReviewClient still calls `markApproved`.

- [ ] **Step 3: Update ReviewDeps**

Use:

```ts
export interface ReviewDeps {
  db: DB
  candidates: ExtractedFieldCandidatesRepo
  reviewVersions: FieldReviewVersionsRepo
  drafts: DraftsRepo
  outbox: OutboxRepo
  conflicts: FieldConflictsRepo
  clock: Clock
  formTypes: FormType[]
  onEnqueued?: () => void
}
```

- [ ] **Step 4: Implement version insertion in `approveForm`**

Rules:

1. Resolve flat form field path to profile path.
2. Build current profile from `currentProfileMap(candidates, reviewVersions, customerId)`.
3. For each edited field:
   - If an unresolved conflict exists and the edit value equals the conflicting candidate value, insert a review version with:
     - `candidateId = conflict.conflicting_candidate_id`
     - `action = 'accepted_conflict'`
     - `valueJson = JSON.stringify(editValue)`
   - Resolve that conflict with the new review version id.
   - Otherwise insert a version with:
     - `candidateId = currentField.candidate.id`
     - `action = 'edited'`
4. For each form-bound field not explicitly edited:
   - Insert a review version with `action = currentField.presence === 'present' ? 'approved' : 'approved_blank'`.
   - `valueJson = currentField.value_json`.
5. Recompute current profile after inserting versions.
6. Render form from the recomputed profile.
7. Preserve existing draft/outbox supersession behavior.

The helper for conflict matching should be pure and small:

```ts
function jsonEquals(a: string | null, b: string | null): boolean {
  return a === b
}
```

No external I/O inside the transaction.

- [ ] **Step 5: Update provenance returned by `getDraft`**

Use `CurrentFieldValue`:

```ts
provenance: field ? {
  quote: field.candidate.evidence_quote,
  span: field.candidate.evidence_span_start !== null ? [field.candidate.evidence_span_start, field.candidate.evidence_span_end] : null,
  confidence: field.candidate.confidence,
  presence: field.presence,
  review_status: field.review_status,
  approved_blank: field.approved_blank,
  review_version: field.review?.version ?? null,
} : null
```

- [ ] **Step 6: Update dependency wiring**

Replace all construction sites:

```ts
new ReviewClient({
  db,
  candidates: new ExtractedFieldCandidatesRepo(db),
  reviewVersions: new FieldReviewVersionsRepo(db),
  drafts: new DraftsRepo(db),
  outbox: new OutboxRepo(db),
  conflicts: new FieldConflictsRepo(db),
  clock,
  formTypes,
})
```

Update `Processor` deps to include `reviewVersions` so it can call `currentProfileMap` before rendering drafts.

- [ ] **Step 7: Run review and integration tests**

```bash
npx vitest run tests/review/reviewClient.test.ts tests/integration/pipeline.test.ts tests/worker/processor.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/review/reviewClient.ts src/server.ts src/worker/processor.ts tests/review/reviewClient.test.ts tests/integration/pipeline.test.ts tests/worker/processor.test.ts
git commit -m "feat(ACORD): store human approvals as field review versions"
```

---

## Task 7: Whole-Branch Rename Cleanup and Docs

**Files:**

- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md`
- Modify: tests/imports across repo

- [ ] **Step 1: Run stale-name scan**

Run:

```bash
rg -n "\bfacts\b|FactsRepo|Fact\b|factSelector|conflicts\b|ConflictsRepo|current_fact_id|conflicting_fact_id|reviewed_value_json|review_status" src tests AGENTS.md docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md
```

Expected before cleanup: references remain.

- [ ] **Step 2: Update AGENTS.md invariant language**

Replace "Fact selection only via `selectCurrentFact`" with:

```markdown
7. **Current profile is computed, not copied.** Machine/source evidence lives in
   `extracted_field_candidates`; human decisions live in immutable
   `field_review_versions`. Candidate selection is pure
   `selectCurrentCandidate` (source_date > confidence > extracted_at). Current reviewed
   values are computed by overlaying the latest review version on the selected candidate.
   Do not copy active reviewed values into candidate rows.
```

Update table naming references:

```text
facts -> extracted_field_candidates
conflicts -> field_conflicts
```

- [ ] **Step 3: Update extraction pipeline plan terminology**

In `docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md`, add a short amendment near the top:

```markdown
### Amendment: Review-Version Model

The implementation uses clearer table names than the original shorthand:

- `facts` became `extracted_field_candidates`.
- `conflicts` became `field_conflicts`.
- Human approval state moved out of candidate rows into immutable `field_review_versions`.

Current canonical values are computed by joining selected candidates with the latest field
review version. Form drafts and outbox payloads remain immutable snapshots.
```

- [ ] **Step 4: Run stale-name scan again**

Run:

```bash
rg -n "\bFactsRepo\b|\bFact\b|factSelector|current_fact_id|conflicting_fact_id|reviewed_value_json" src tests
```

Expected: no production references. Test comments may mention old names only when explaining migration from the old design; prefer removing them.

- [ ] **Step 5: Full verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
rg -n "from ['\"]ai['\"]|from ['\"]@ai-sdk/openai['\"]|generateObject" src tests
rg -n "\bDate\.now\b|new Date\(|toISOString\(" src tests
rg -n "\bas any\b|:\s*any\b|unknown\s+as|@ts-ignore|@ts-expect-error|eslint-disable|Function\b" src tests
rg -n "ORDER BY id|collection\[[0-9]+\]|req\.body as|db\.transaction\([^)]*async|fillForm\(|\.put\(" src
```

Expected:

- Tests pass.
- Typecheck passes.
- Diff check passes.
- `ai` imports only in `src/extraction/llmClient.ts`.
- Wall-clock/date formatting only in `src/clock.ts` or comments.
- No production type escape hatches.
- No `fillForm`/blob write inside DB transactions.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/plans/2026-07-03-acord-extraction-pipeline.md src tests
git commit -m "docs(ACORD): document candidate and review-version model"
```

---

## Self-Review

**Spec coverage:**

- Clear table names: `facts` -> `extracted_field_candidates`, `conflicts` -> `field_conflicts`.
- Full review history: `field_review_versions` stores every human decision as an immutable version.
- Active value by latest version: `latestByField` and `currentProfileMap` implement it.
- No cascading updates: candidates, review versions, conflicts, drafts, and outbox rows refer to each other by id; current reads join/project.
- Historical snapshots: `form_drafts.projected_json` and `outbox.payload_json` stay snapshots, not live joins.
- Correction approval: matching conflict edits create an `accepted_conflict` review version pointing at the newer candidate and resolve the conflict with `resolved_by_review_version_id`.

**Placeholder scan:**

- No TBD/TODO/later placeholders.
- Each task has concrete tests, implementation signatures, commands, and expected outcomes.

**Type consistency:**

- `ExtractedFieldCandidate`, `FieldReviewVersion`, `CurrentFieldValue` are introduced in Task 1 and used consistently afterward.
- `ExtractedFieldCandidatesRepo`, `FieldReviewVersionsRepo`, and `FieldConflictsRepo` names match all later tasks.
- `selectCurrentCandidate` replaces `selectCurrentFact`; review overlay moves to `currentProfileMap`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-field-review-versions.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fastest safe iteration.
2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, with checkpoints after each task.

Which approach?
