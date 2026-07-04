# ACORD Extraction Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-style TypeScript service that ingests call transcripts via webhook, extracts a canonical `BusinessProfile` with an LLM (behind a mockable interface), lets a human review/correct/approve per ACORD form, and fills PDFs via a durable outbox — all persisted in SQLite.

**Architecture:** Transcripts land durably (source + `processing_jobs` row in one txn). A claim-based processor extracts facts (value + presence + provenance + confidence) into an append-only ledger; each ACORD form is a pure projection of the canonical profile. `approveForm` commits the human decision + an outbox row in one short txn; an in-process token-fenced worker calls `fillForm` asynchronously. Correctness edges (out-of-order corrections, stable collection IDs, lease recovery, immutable filled drafts) are first-class.

**Tech Stack:** TypeScript (ESM), Node 20+, Fastify, Zod, better-sqlite3, Vercel AI SDK v6 (`generateText` + `Output.object`, behind `LlmClient`), Vitest.

### Amendment: Review-Version Model

The implementation uses clearer table names than the original shorthand:

- `facts` became `extracted_field_candidates`.
- `conflicts` became `field_conflicts`.
- Human approval state moved out of candidate rows into immutable `field_review_versions`.

Current canonical values are computed from selected candidates plus the latest field review
version. Reads keep `selected_candidate` separate from `value_candidate` so provenance always
points at the evidence behind the displayed value. Form drafts and outbox payloads remain
immutable snapshots.

## Global Constraints

- **Language:** TypeScript, ESM (`"type": "module"`), `strict: true`. Node ≥ 20.
- **LLM API:** Vercel AI SDK **v6** (`ai@^6`, `@ai-sdk/openai@^3`) structured-output API — top-level `generateText({ output: Output.object({ schema }) })`, reading `result.output`. `generateObject` is deprecated; do not use it. The `@ai-sdk/openai` major must be the one that lists `ai@^6` as its peer (v3.x at time of writing) — if npm reports a peer-dep conflict, take the provider major the installed `ai@6` requires. All LLM access goes through the `LlmClient` interface; nothing else imports `ai` directly.
- **DB:** better-sqlite3 (synchronous). Every write path that spans >1 row is wrapped in a single `db.transaction(...)`. Never call external I/O (`fillForm`, blob writes) inside a DB transaction.
- **Field paths:** scalars/fixed objects use static dotted paths (`mailing_address.street`); repeated collections use `collection.{item_id}.field` — **never** array indices in the canonical store.
- **Presence is explicit:** every fact has `presence ∈ {present, missing, needs_follow_up, not_applicable}`; `evidence` is `null` for `missing`. No bare ambiguous nulls.
- **Fact selection** is the pure function `selectCurrentFact` (approval > source_date > confidence > extracted_at), never `ORDER BY id`.
- **Lease claims** stamp a fresh `lock_token` + `locked_until`; every completion is guarded by `... WHERE id=? AND lock_token=? AND status='processing'`.
- **`fillForm`** writes a deterministic blob key `pdf/{customerId}/{formType}/{contentHash}`; it is a stub (no real PDF).
- **Timestamps:** ISO-8601 UTC strings. A single `Clock` interface (`now(): string`) is injected everywhere time is read, so tests are deterministic.
- **IDs:** `newId()` (uuid v4) for surrogate keys; deterministic hash ids for `collection_items` (`sha256(customerId|collection|naturalKey)` truncated).

---

## ⚠️ Explicit Scope / Deferrals (read before implementing)

This plan builds the **full pipeline and every correctness invariant** end-to-end, but
deliberately wires a **representative field set**, not all of `schema.md`:

- **ACORD 125** is wired with a real cross-section of fields (identity, revenue, employees,
  mailing address leaves, one `claims` collection).
- **ACORD 126** is wired with **only the fields it shares with 125** (`employee_count_*`) —
  enough to prove the DRY overlap and the cross-form shared-field ripple. 126-specific
  fields (GL premises, hazard classifications, products schedule) are **not** wired.
- `annual_payroll`, `prior_carrier_*`, and the collections `locations`,
  `prior_carriers`, `hazard_classifications`, `additional_insureds`, `products_schedule`
  are **not** bound to a form in this build.
- **Reviewer-initiated `not_applicable` is deferred.** `markApproved` sets `review_status`
  and `reviewed_value_json` only — it does **not** mutate `presence`. Two consequences:
  - **Supported:** approving a field that is already `missing`/`needs_follow_up` with a null
    value (`markApproved(id, null, …)`) → the read model reports `approved_blank` (a human
    signed off on leaving it blank). This path works end-to-end and is tested.
  - **Not built:** a reviewer explicitly flipping a `present` field to `not_applicable`. That
    needs a `markNotApplicable` write path (a one-line `UPDATE … SET presence='not_applicable'`)
    plus a `ReviewClient` method + wiring. It is a mechanical extension, intentionally omitted.

Extending to every field is **mechanical**: add rows to `STATIC_BINDINGS` /
`COLLECTION_BINDINGS` and fields to `ExtractionEnvelope`. No architecture changes. Any field
present in the envelope but absent from a form's bindings is extracted and stored but never
projected — that is intentional here, not a bug. **Do not claim full ACORD coverage.**

---

## File Structure

```
src/
  clock.ts                     Clock interface + system/fixed impls
  util/hash.ts                 sha256 helpers (contentHash, itemId)
  util/id.ts                   newId(), newLockToken()
  schema/profile.ts            BusinessProfile Zod + EnvelopeField + presence enums
  schema/forms.ts              ACORD 125/126 form-field TS types
  db/sqlite.ts                 openDb(), migrate()
  db/migrations.ts             all CREATE TABLE DDL
  db/repos/sources.ts          SourcesRepo
  db/repos/jobs.ts             ProcessingJobsRepo (+ generic lease claim)
  db/repos/facts.ts            FactsRepo
  db/repos/collectionItems.ts  CollectionItemsRepo
  db/repos/drafts.ts           DraftsRepo (+ draft_field_bindings)
  db/repos/outbox.ts           OutboxRepo
  db/repos/conflicts.ts        ConflictsRepo
  lease/leaseClaimer.ts        claim()/complete()/fail() with token+status fencing
  profile/factSelector.ts      selectCurrentFact()
  profile/collectionIdentity.ts resolveItemId()
  profile/reconciler.ts        reconcile(): candidates -> current facts + conflicts + missing rows
  forms/bindings.ts            static (formType,formFieldPath)<->profileFieldPath
  forms/renderers.ts           renderForm -> flat { mapping, fieldBindings }; toFillMapping -> nested fill_form shape
  forms/fillForm.ts            fillForm() stub
  blob/blobStore.ts            put()/get() against a local dir
  extraction/llmClient.ts      LlmClient interface + AiSdkLlmClient + MockLlmClient
  extraction/evidenceMatcher.ts locateEvidence()
  extraction/extractor.ts      extract(): transcript -> fact candidates
  review/reviewClient.ts       ReviewClient (getDraft, approveForm, conflicts)
  worker/processor.ts          claims processing_jobs -> extract+reconcile+project
  worker/outboxWorker.ts       claims outbox -> fillForm -> filled
  ingest/webhook.ts            Fastify route: POST /webhook/transcript
  server.ts                    compose everything (DI)
tests/
  fixtures/transcripts.json    the provided transcript (copied)
  fixtures/correction.json     synthetic 2nd transcript (revenue + payroll)
  fixtures/llm/*.json          canned MockLlmClient outputs
  <mirrors src per unit>
```

---

## Task 1: Project scaffold + Clock + id/hash utils

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/clock.ts`, `src/util/id.ts`, `src/util/hash.ts`
- Test: `tests/util/hash.test.ts`

**Interfaces:**
- Produces: `interface Clock { now(): string }`, `class SystemClock`, `class FixedClock`; `newId(): string`, `newLockToken(): string`; `contentHash(obj: unknown): string`, `itemIdFor(customerId: string, collection: string, naturalKey: string): string`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "acord-pipeline",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "tsx src/server.ts"
  },
  "dependencies": {
    "ai": "^6.0.0",
    "@ai-sdk/openai": "^3.0.0",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "uuid": "^11.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `.gitignore`**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } })
```

```
# .gitignore
node_modules/
dist/
*.db
data/
.env
```

- [ ] **Step 4: Write `src/clock.ts` and `src/util/id.ts`**

```ts
// src/clock.ts
export interface Clock { now(): string }
export class SystemClock implements Clock { now(): string { return new Date().toISOString() } }
export class FixedClock implements Clock {
  constructor(private t: string) {}
  set(t: string) { this.t = t }
  now(): string { return this.t }
}
```

```ts
// src/util/id.ts
import { v4 as uuidv4 } from 'uuid'
export const newId = (): string => uuidv4()
export const newLockToken = (): string => uuidv4()
```

- [ ] **Step 5: Write the failing test for hashing**

```ts
// tests/util/hash.test.ts
import { describe, it, expect } from 'vitest'
import { contentHash, itemIdFor, factIdFor } from '../../src/util/hash.js'

describe('contentHash', () => {
  it('is stable regardless of key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }))
  })
  it('changes when a value changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
  })
})

describe('itemIdFor', () => {
  it('is deterministic for the same natural key', () => {
    expect(itemIdFor('cust1', 'claims', '2023|workers_comp'))
      .toBe(itemIdFor('cust1', 'claims', '2023|workers_comp'))
  })
  it('differs across collections and customers', () => {
    expect(itemIdFor('cust1', 'claims', 'k')).not.toBe(itemIdFor('cust1', 'locations', 'k'))
    expect(itemIdFor('cust1', 'claims', 'k')).not.toBe(itemIdFor('cust2', 'claims', 'k'))
  })
})

describe('factIdFor', () => {
  it('is identical for the same (customer, field, source) — idempotent reprocessing', () => {
    expect(factIdFor('c1', 'annual_gross_revenue', 's1')).toBe(factIdFor('c1', 'annual_gross_revenue', 's1'))
  })
  it('differs across sources so multi-transcript candidates coexist', () => {
    expect(factIdFor('c1', 'annual_gross_revenue', 's1')).not.toBe(factIdFor('c1', 'annual_gross_revenue', 's2'))
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm i && npx vitest run tests/util/hash.test.ts`
Expected: FAIL — cannot find module `hash.js`.

- [ ] **Step 7: Implement `src/util/hash.ts`**

```ts
// src/util/hash.ts
import { createHash } from 'node:crypto'

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

export function contentHash(obj: unknown): string {
  return createHash('sha256').update(stableStringify(obj)).digest('hex')
}

export function itemIdFor(customerId: string, collection: string, naturalKey: string): string {
  return createHash('sha256').update(`${customerId}|${collection}|${naturalKey}`).digest('hex').slice(0, 24)
}

/**
 * Deterministic fact id so re-extracting the SAME source is idempotent: same
 * (customer, field_path, source_id) -> same PK -> INSERT OR IGNORE de-dupes on reprocessing
 * (and preserves any human approval already on the row). Different sources -> different ids
 * (the multi-transcript candidate ledger).
 */
export function factIdFor(customerId: string, fieldPath: string, sourceId: string): string {
  return createHash('sha256').update(`${customerId}|${fieldPath}|${sourceId}`).digest('hex').slice(0, 32)
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/util/hash.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/clock.ts src/util tests/util
git commit -m "chore: scaffold project + clock/id/hash utils"
```

---

## Task 2: Domain schemas (profile envelope + presence + forms)

**Files:**
- Create: `src/schema/profile.ts`, `src/schema/forms.ts`
- Test: `tests/schema/profile.test.ts`

**Interfaces:**
- Produces: `Presence` (`'present'|'missing'|'needs_follow_up'|'not_applicable'`), `ReviewStatus` (`'needs_review'|'approved'|'conflict'`), `MatchQuality` (`'exact'|'normalized'|'ambiguous'|'none'`); `EnvelopeField<T>` type + `envelopeField(schema)` Zod builder; `ExtractionEnvelope` Zod schema; `Fact` type; `FormType = 'acord_125' | 'acord_126'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/schema/profile.test.ts
import { describe, it, expect } from 'vitest'
import { ExtractionEnvelope } from '../../src/schema/profile.js'

describe('ExtractionEnvelope', () => {
  it('accepts a present field with evidence', () => {
    const parsed = ExtractionEnvelope.parse({
      annual_gross_revenue: { value: 2500000, presence: 'present', confidence: 0.6, evidence: 'about two and a half million' },
    })
    expect(parsed.annual_gross_revenue?.value).toBe(2500000)
  })
  it('accepts a missing field with null value and null evidence', () => {
    const parsed = ExtractionEnvelope.parse({
      annual_gross_revenue: { value: null, presence: 'missing', confidence: 0, evidence: null },
    })
    expect(parsed.annual_gross_revenue?.presence).toBe('missing')
  })
  it('rejects an invalid presence', () => {
    expect(() => ExtractionEnvelope.parse({
      annual_gross_revenue: { value: 1, presence: 'unknown', confidence: 1, evidence: 'x' },
    })).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/schema/profile.test.ts`
Expected: FAIL — cannot find `profile.js`.

- [ ] **Step 3: Implement `src/schema/profile.ts`**

```ts
// src/schema/profile.ts
import { z } from 'zod'

export const presenceValues = ['present', 'missing', 'needs_follow_up', 'not_applicable'] as const
export const Presence = z.enum(presenceValues)
export type Presence = z.infer<typeof Presence>

export type ReviewStatus = 'needs_review' | 'approved' | 'conflict'
export type MatchQuality = 'exact' | 'normalized' | 'ambiguous' | 'none'
export type FormType = 'acord_125' | 'acord_126'

/** One extracted field: value + why-it-is/isn't-there + confidence + provenance quote. */
export function envelopeField<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    presence: Presence,
    confidence: z.number().min(0).max(1),
    evidence: z.string().nullable(), // null for a truly missing field
  })
}
export type EnvelopeField<T> = { value: T | null; presence: Presence; confidence: number; evidence: string | null }

const Address = z.object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() })

/**
 * The fields the pipeline extracts. This is the representative, runnable set the tests
 * exercise; extending to every schema.md field is mechanical (same envelopeField pattern).
 * Repeated collections are arrays of objects each carrying a natural_key for identity.
 */
export const ExtractionEnvelope = z.object({
  policyholder_first_name: envelopeField(z.string()).optional(),
  policyholder_last_name: envelopeField(z.string()).optional(),
  dba_name: envelopeField(z.string()).optional(),
  entity_type: envelopeField(z.enum(['LLC', 'Corporation', 'SoleProprietor', 'Partnership'])).optional(),
  fein: envelopeField(z.string()).optional(),
  annual_gross_revenue: envelopeField(z.number()).optional(),
  annual_payroll: envelopeField(z.number()).optional(),
  employee_count_full_time: envelopeField(z.number().int()).optional(),
  employee_count_part_time: envelopeField(z.number().int()).optional(),
  mailing_address: envelopeField(Address).optional(),
  premises_address: envelopeField(Address).optional(),
  prior_carrier_name: envelopeField(z.string()).optional(),
  prior_expiration_date: envelopeField(z.string()).optional(),
  claims: z.array(z.object({
    natural_key: z.string(),          // e.g. "2023|workers_comp"
    year: envelopeField(z.number().int()),
    type: envelopeField(z.string()),
    amount: envelopeField(z.number()),
    description: envelopeField(z.string()),
  })).optional(),
})
export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelope>

/** A persisted fact (one field of the canonical profile). */
export interface Fact {
  id: string
  customer_id: string
  field_path: string          // scalar: "annual_gross_revenue"; item: "claims.{item_id}.amount"
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
  review_status: ReviewStatus
  reviewed_value_json: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  superseded_by: string | null
}
```

- [ ] **Step 4: Implement `src/schema/forms.ts`**

```ts
// src/schema/forms.ts
import type { FormType } from './profile.js'
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/schema/profile.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/schema tests/schema
git commit -m "feat: domain schemas (envelope, presence, forms)"
```

---

## Task 3: SQLite connection + migrations (all tables)

**Files:**
- Create: `src/db/sqlite.ts`, `src/db/migrations.ts`
- Test: `tests/db/migrations.test.ts`

**Interfaces:**
- Produces: `openDb(path = ':memory:'): Database` (better-sqlite3 instance with `PRAGMA journal_mode=WAL`, `foreign_keys=ON`), `migrate(db): void`. All tables from the spec's Data Model.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/migrations.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../../src/db/sqlite.js'

describe('migrate', () => {
  it('creates every table', () => {
    const db = openDb()
    migrate(db)
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    for (const t of ['sources','processing_jobs','facts','collection_items','form_drafts','draft_field_bindings','outbox','conflicts','customers']) {
      expect(names).toContain(t)
    }
  })
  it('is idempotent', () => {
    const db = openDb(); migrate(db); expect(() => migrate(db)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/migrations.test.ts`
Expected: FAIL — cannot find `sqlite.js`.

- [ ] **Step 3: Implement `src/db/sqlite.ts`**

```ts
// src/db/sqlite.ts
import Database from 'better-sqlite3'
import { DDL } from './migrations.js'
export type DB = Database.Database

export function openDb(path = ':memory:'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
export function migrate(db: DB): void { db.exec(DDL) }
```

- [ ] **Step 4: Implement `src/db/migrations.ts`**

```ts
// src/db/migrations.ts
export const DDL = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT, dba TEXT, owner TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, type TEXT NOT NULL,
  source_date TEXT NOT NULL, received_at TEXT NOT NULL, raw_json TEXT NOT NULL,
  checksum TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received'
);
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, locked_until TEXT, lock_token TEXT, locked_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, field_path TEXT NOT NULL,
  value_json TEXT, presence TEXT NOT NULL, confidence REAL NOT NULL,
  evidence_quote TEXT, evidence_span_start INTEGER, evidence_span_end INTEGER,
  match_quality TEXT NOT NULL, source_id TEXT NOT NULL, source_date TEXT NOT NULL,
  extracted_at TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'needs_review',
  reviewed_value_json TEXT, reviewed_by TEXT, reviewed_at TEXT, superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(customer_id, field_path, superseded_by);
CREATE TABLE IF NOT EXISTS collection_items (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, collection TEXT NOT NULL,
  natural_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(customer_id, collection, natural_key)
);
CREATE TABLE IF NOT EXISTS form_drafts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, form_type TEXT NOT NULL,
  revision INTEGER NOT NULL, projected_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review', approved_by TEXT, approved_at TEXT,
  pdf_ref TEXT, superseded_by_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(customer_id, form_type, revision)
);
CREATE TABLE IF NOT EXISTS draft_field_bindings (
  draft_id TEXT NOT NULL, form_field_path TEXT NOT NULL, profile_field_path TEXT NOT NULL,
  PRIMARY KEY (draft_id, form_field_path)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, form_type TEXT NOT NULL,
  draft_revision INTEGER NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, locked_until TEXT, lock_token TEXT, locked_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, field_path TEXT NOT NULL,
  current_fact_id TEXT NOT NULL, conflicting_fact_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved', resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL
);
`
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/db/migrations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/sqlite.ts src/db/migrations.ts tests/db
git commit -m "feat: sqlite connection + full schema migration"
```

---

## Task 4: Lease-claim primitive with token+status fencing

**Files:**
- Create: `src/lease/leaseClaimer.ts`
- Test: `tests/lease/leaseClaimer.test.ts`

**Interfaces:**
- Consumes: `DB` (Task 3), `Clock` (Task 1), `newLockToken` (Task 1).
- Produces: `class LeaseClaimer` bound to a table name, with
  `claim(now, leaseMs, workerId, limit): { id: string; lock_token: string }[]`,
  `complete(id, lockToken): boolean`,
  `fail(id, lockToken, nextAttemptAt, maxAttempts): boolean` (dead-letters when attempts+1 >= max).
  Works for any table having columns `status, attempts, next_attempt_at, locked_until, lock_token, locked_by`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lease/leaseClaimer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'

function seedOutbox(db: DB, id: string, nextAttemptAt = '2025-01-01T00:00:00Z') {
  db.prepare(`INSERT INTO outbox (id, customer_id, form_type, draft_revision, payload_json, content_hash, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'c1', 'acord_125', 1, '{}', 'h', 'pending', 0, ?, '2025-01-01T00:00:00Z')`).run(id, nextAttemptAt)
}

describe('LeaseClaimer', () => {
  let db: DB, lease: LeaseClaimer
  beforeEach(() => { db = openDb(); migrate(db); lease = new LeaseClaimer(db, 'outbox') })

  it('claims a pending row and stamps a token', () => {
    seedOutbox(db, 'o1')
    const claimed = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.lock_token).toBeTruthy()
  })

  it('does not double-claim an unexpired lease', () => {
    seedOutbox(db, 'o1')
    lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    const second = lease.claim('2025-01-02T00:00:10Z', 30_000, 'w2', 10) // within 30s lease
    expect(second).toHaveLength(0)
  })

  it('reclaims an expired lease with a fresh token', () => {
    seedOutbox(db, 'o1')
    const first = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    const second = lease.claim('2025-01-02T00:01:00Z', 30_000, 'w2', 10) // 60s later, expired
    expect(second).toHaveLength(1)
    expect(second[0]!.lock_token).not.toBe(first[0]!.lock_token)
  })

  it('complete() succeeds for the current token, no-ops for a stale one', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    expect(lease.complete('o1', 'stale-token')).toBe(false)
    expect(lease.complete('o1', c!.lock_token)).toBe(true)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o1'").get()).toMatchObject({ status: 'done' })
  })

  it('complete() no-ops once the row was cancelled (status != processing)', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 10)
    db.prepare("UPDATE outbox SET status='cancelled' WHERE id='o1'").run()
    expect(lease.complete('o1', c!.lock_token)).toBe(false)
  })

  it('fail() dead-letters when attempts reach max', () => {
    seedOutbox(db, 'o1')
    const [c] = lease.claim('2025-01-02T00:00:00Z', 30_000, 'w1', 1)
    expect(lease.fail('o1', c!.lock_token, '2025-01-02T00:05:00Z', 1)).toBe(true)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o1'").get()).toMatchObject({ status: 'dead' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lease/leaseClaimer.test.ts`
Expected: FAIL — cannot find `leaseClaimer.js`.

- [ ] **Step 3: Implement `src/lease/leaseClaimer.ts`**

```ts
// src/lease/leaseClaimer.ts
import type { DB } from '../db/sqlite.js'
import { newLockToken } from '../util/id.js'

export class LeaseClaimer {
  constructor(private db: DB, private table: string) {}

  /**
   * Atomically lease up to `limit` rows that are pending or lease-expired and due.
   *
   * Two workers on separate connections must never claim the same row. Guarantees:
   *  - `.immediate()` starts the transaction with `BEGIN IMMEDIATE`, taking SQLite's
   *    write lock up front — concurrent claimers serialize instead of both reading the
   *    same pending set under a shared read lock and then colliding on UPDATE.
   *  - Each UPDATE re-checks the claimable predicate in its `WHERE` (guarded update),
   *    so even without the lock a row already taken by another worker yields
   *    `changes === 0` and is skipped. We return ONLY rows whose update won.
   */
  claim(now: string, leaseMs: number, workerId: string, limit: number): { id: string; lock_token: string }[] {
    const lockedUntil = new Date(new Date(now).getTime() + leaseMs).toISOString()
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT id FROM ${this.table}
         WHERE (status='pending' OR (status='processing' AND locked_until < @now))
           AND next_attempt_at <= @now
         ORDER BY next_attempt_at ASC LIMIT @limit`
      ).all({ now, limit }) as { id: string }[]
      const out: { id: string; lock_token: string }[] = []
      const upd = this.db.prepare(
        `UPDATE ${this.table} SET status='processing', locked_until=@lockedUntil, lock_token=@token, locked_by=@workerId
         WHERE id=@id AND (status='pending' OR (status='processing' AND locked_until < @now))`
      )
      for (const r of rows) {
        const token = newLockToken()
        const info = upd.run({ id: r.id, now, lockedUntil, token, workerId })
        if (info.changes === 1) out.push({ id: r.id, lock_token: token }) // only winners
      }
      return out
    })
    return tx.immediate() // BEGIN IMMEDIATE: acquire the write lock before selecting
  }

  /** Mark done — only the current lease holder of a still-processing row wins (fencing). */
  complete(id: string, lockToken: string): boolean {
    const info = this.db.prepare(
      `UPDATE ${this.table} SET status='done', locked_until=NULL, lock_token=NULL
       WHERE id=? AND lock_token=? AND status='processing'`
    ).run(id, lockToken)
    return info.changes === 1
  }

  /** Record a failure: bump attempts + backoff, dead-letter at max. Fenced like complete(). */
  fail(id: string, lockToken: string, nextAttemptAt: string, maxAttempts: number): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT attempts FROM ${this.table} WHERE id=? AND lock_token=? AND status='processing'`
      ).get(id, lockToken) as { attempts: number } | undefined
      if (!row) return false
      const attempts = row.attempts + 1
      const status = attempts >= maxAttempts ? 'dead' : 'pending'
      this.db.prepare(
        `UPDATE ${this.table} SET status=@status, attempts=@attempts, next_attempt_at=@next,
         locked_until=NULL, lock_token=NULL WHERE id=@id`
      ).run({ status, attempts, next: nextAttemptAt, id })
      return true
    })
    return tx()
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lease/leaseClaimer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lease tests/lease
git commit -m "feat: lease-claim primitive with token+status fencing"
```

---

## Task 5: `selectCurrentFact` (pure selection rule)

**Files:**
- Create: `src/profile/factSelector.ts`
- Test: `tests/profile/factSelector.test.ts`

**Interfaces:**
- Consumes: `Fact` (Task 2).
- Produces: `selectCurrentFact(candidates: Fact[]): Fact | undefined` — order: approved-first, then newest `source_date`, then highest `confidence`, then latest `extracted_at`. Ignores rows with `superseded_by` set.

- [ ] **Step 1: Write the failing test**

```ts
// tests/profile/factSelector.test.ts
import { describe, it, expect } from 'vitest'
import { selectCurrentFact } from '../../src/profile/factSelector.js'
import type { Fact } from '../../src/schema/profile.js'

const base: Fact = {
  id: 'x', customer_id: 'c1', field_path: 'annual_gross_revenue', value_json: '1',
  presence: 'present', confidence: 0.5, evidence_quote: null, evidence_span_start: null,
  evidence_span_end: null, match_quality: 'none', source_id: 's', source_date: '2025-01-01T00:00:00Z',
  extracted_at: '2025-01-01T00:00:00Z', review_status: 'needs_review', reviewed_value_json: null,
  reviewed_by: null, reviewed_at: null, superseded_by: null,
}
const f = (o: Partial<Fact>): Fact => ({ ...base, ...o })

describe('selectCurrentFact', () => {
  it('prefers an approved fact over a newer machine one', () => {
    const approved = f({ id: 'a', review_status: 'approved', source_date: '2025-01-01T00:00:00Z' })
    const newerMachine = f({ id: 'b', review_status: 'needs_review', source_date: '2025-06-01T00:00:00Z' })
    expect(selectCurrentFact([newerMachine, approved])!.id).toBe('a')
  })
  it('among machine facts, newest source_date wins regardless of arrival', () => {
    const older = f({ id: 'o', source_date: '2025-01-01T00:00:00Z', extracted_at: '2025-09-01T00:00:00Z' })
    const newer = f({ id: 'n', source_date: '2025-03-01T00:00:00Z', extracted_at: '2025-02-01T00:00:00Z' })
    expect(selectCurrentFact([older, newer])!.id).toBe('n')
  })
  it('breaks source_date ties by confidence', () => {
    const lo = f({ id: 'lo', confidence: 0.3 })
    const hi = f({ id: 'hi', confidence: 0.9 })
    expect(selectCurrentFact([lo, hi])!.id).toBe('hi')
  })
  it('ignores superseded rows', () => {
    const dead = f({ id: 'd', review_status: 'approved', superseded_by: 'z' })
    const live = f({ id: 'l' })
    expect(selectCurrentFact([dead, live])!.id).toBe('l')
  })
  it('returns undefined for no candidates', () => {
    expect(selectCurrentFact([])).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/profile/factSelector.test.ts`
Expected: FAIL — cannot find `factSelector.js`.

- [ ] **Step 3: Implement `src/profile/factSelector.ts`**

```ts
// src/profile/factSelector.ts
import type { Fact } from '../schema/profile.js'

const approvedRank = (f: Fact): number => (f.review_status === 'approved' ? 1 : 0)

/** Deterministic current-fact rule: approval > source_date > confidence > extracted_at. */
export function selectCurrentFact(candidates: Fact[]): Fact | undefined {
  const live = candidates.filter(c => c.superseded_by === null)
  if (live.length === 0) return undefined
  return [...live].sort((a, b) =>
    approvedRank(b) - approvedRank(a) ||
    b.source_date.localeCompare(a.source_date) ||
    b.confidence - a.confidence ||
    b.extracted_at.localeCompare(a.extracted_at)
  )[0]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/profile/factSelector.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/profile/factSelector.ts tests/profile/factSelector.test.ts
git commit -m "feat: selectCurrentFact selection rule"
```

---

## Task 6: Collection identity (idempotent item_id)

**Files:**
- Create: `src/db/repos/collectionItems.ts`, `src/profile/collectionIdentity.ts`
- Test: `tests/profile/collectionIdentity.test.ts`

**Interfaces:**
- Consumes: `DB`, `Clock`, `itemIdFor` (Task 1).
- Produces: `class CollectionItemsRepo { findId(customerId, collection, naturalKey): string | undefined; insert(id, customerId, collection, naturalKey, now): void }`; `resolveItemId(repo, clock, customerId, collection, naturalKey): string` — deterministic id via `itemIdFor`, persisted in registry on first sight, returned unchanged thereafter.

- [ ] **Step 1: Write the failing test**

```ts
// tests/profile/collectionIdentity.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { resolveItemId } from '../../src/profile/collectionIdentity.js'
import { FixedClock } from '../../src/clock.js'

describe('resolveItemId', () => {
  let db: DB, repo: CollectionItemsRepo
  const clock = new FixedClock('2025-01-01T00:00:00Z')
  beforeEach(() => { db = openDb(); migrate(db); repo = new CollectionItemsRepo(db) })

  it('returns the same id for the same natural key across calls (idempotent)', () => {
    const a = resolveItemId(repo, clock, 'c1', 'claims', '2023|workers_comp')
    const b = resolveItemId(repo, clock, 'c1', 'claims', '2023|workers_comp')
    expect(a).toBe(b)
    expect(db.prepare('SELECT COUNT(*) n FROM collection_items').get()).toMatchObject({ n: 1 })
  })

  it('distinct natural keys get distinct ids', () => {
    const a = resolveItemId(repo, clock, 'c1', 'claims', '2023|workers_comp')
    const b = resolveItemId(repo, clock, 'c1', 'claims', '2024|auto')
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/profile/collectionIdentity.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/db/repos/collectionItems.ts`**

```ts
// src/db/repos/collectionItems.ts
import type { DB } from '../sqlite.js'

export class CollectionItemsRepo {
  constructor(private db: DB) {}
  findId(customerId: string, collection: string, naturalKey: string): string | undefined {
    const row = this.db.prepare(
      'SELECT id FROM collection_items WHERE customer_id=? AND collection=? AND natural_key=?'
    ).get(customerId, collection, naturalKey) as { id: string } | undefined
    return row?.id
  }
  insert(id: string, customerId: string, collection: string, naturalKey: string, now: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO collection_items (id, customer_id, collection, natural_key, created_at)
       VALUES (?,?,?,?,?)`
    ).run(id, customerId, collection, naturalKey, now)
  }
}
```

- [ ] **Step 4: Implement `src/profile/collectionIdentity.ts`**

```ts
// src/profile/collectionIdentity.ts
import type { Clock } from '../clock.js'
import type { CollectionItemsRepo } from '../db/repos/collectionItems.js'
import { itemIdFor } from '../util/hash.js'

/**
 * Deterministic id (idempotent under reprocessing) + registry lookup: a re-seen IDENTICAL
 * natural key resolves to the existing item. A CHANGED natural key misses the registry and
 * mints a new item (surfaced for human merge) — we do not fuzzy-re-identify.
 */
export function resolveItemId(
  repo: CollectionItemsRepo, clock: Clock,
  customerId: string, collection: string, naturalKey: string,
): string {
  const existing = repo.findId(customerId, collection, naturalKey)
  if (existing) return existing
  const id = itemIdFor(customerId, collection, naturalKey)
  repo.insert(id, customerId, collection, naturalKey, clock.now())
  return id
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/profile/collectionIdentity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/collectionItems.ts src/profile/collectionIdentity.ts tests/profile/collectionIdentity.test.ts
git commit -m "feat: idempotent collection item identity"
```

---

## Task 7: Form bindings + renderers (with per-draft array bindings)

**Files:**
- Create: `src/forms/bindings.ts`, `src/forms/renderers.ts`
- Test: `tests/forms/renderers.test.ts`

**Interfaces:**
- Consumes: `FormType`, `RenderResult`, `FieldBinding`, `FormMapping` (Task 2); `Fact` (Task 2).
- Produces:
  - `STATIC_BINDINGS: Record<FormType, { form_field_path: string; profile_field_path: string }[]>` (scalars/fixed).
  - `reverseResolve(formType, formFieldPath, draftBindings): string | undefined` — array paths via `draftBindings`, else static.
  - `renderForm(formType, currentFacts: Map<string,Fact>): RenderResult` — walks static + expands `claims.{item_id}.*` positionally into `claims[i].*`, emitting per-draft `FieldBinding`s. Produces the FLAT review mapping only.
  - `toFillMapping(flat: FormMapping): FillMapping` — pure unflatten of the flat review mapping into the nested `fill_form` contract shape (dotted keys → nested objects, `claims[i].*` → arrays). Called at approve time to build the outbox payload; the flat mapping is what humans review.

- [ ] **Step 1: Write the failing test**

```ts
// tests/forms/renderers.test.ts
import { describe, it, expect } from 'vitest'
import { renderForm, reverseResolve, toFillMapping } from '../../src/forms/renderers.js'
import type { Fact } from '../../src/schema/profile.js'

function fact(field_path: string, value: unknown): Fact {
  return {
    id: field_path, customer_id: 'c1', field_path, value_json: JSON.stringify(value),
    presence: 'present', confidence: 1, evidence_quote: null, evidence_span_start: null,
    evidence_span_end: null, match_quality: 'exact', source_id: 's', source_date: '2025-01-01T00:00:00Z',
    extracted_at: '2025-01-01T00:00:00Z', review_status: 'approved', reviewed_value_json: null,
    reviewed_by: null, reviewed_at: null, superseded_by: null,
  }
}

describe('renderForm', () => {
  it('renders scalar fields onto acord_125', () => {
    const facts = new Map([['policyholder_first_name', fact('policyholder_first_name', 'Mike')]])
    const { mapping } = renderForm('acord_125', facts)
    expect(mapping.policyholder_first_name).toBe('Mike')
  })

  it('renders the human-approved correction, not the stale machine value', () => {
    const corrected = fact('annual_gross_revenue', 2500000)   // machine value
    corrected.reviewed_value_json = JSON.stringify(2800000)    // human edit, review_status already 'approved'
    const { mapping } = renderForm('acord_125', new Map([['annual_gross_revenue', corrected]]))
    expect(mapping.annual_gross_revenue).toBe(2800000)
  })

  it('expands a claims collection positionally and emits per-draft bindings', () => {
    const facts = new Map([
      ['claims.itemA.amount', fact('claims.itemA.amount', 30000)],
      ['claims.itemB.amount', fact('claims.itemB.amount', 15000)],
    ])
    const { mapping, fieldBindings } = renderForm('acord_125', facts)
    // positional order is by item_id for determinism
    expect(mapping['claims[0].amount']).toBe(30000)
    expect(mapping['claims[1].amount']).toBe(15000)
    const b0 = fieldBindings.find(b => b.form_field_path === 'claims[0].amount')
    expect(b0?.profile_field_path).toBe('claims.itemA.amount')
  })

  it('reverseResolve uses per-draft bindings for array paths', () => {
    const draftBindings = [{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.itemA.amount' }]
    expect(reverseResolve('acord_125', 'claims[0].amount', draftBindings)).toBe('claims.itemA.amount')
  })

  it('reverseResolve falls back to static map for scalars', () => {
    expect(reverseResolve('acord_125', 'policyholder_first_name', [])).toBe('policyholder_first_name')
  })
})

describe('toFillMapping', () => {
  it('nests dotted keys into the fill_form contract object shape', () => {
    const flat = {
      fein: '12-3456789',
      'mailing_address.street': 'PO Box 9102',
      'mailing_address.city': 'Wilmington',
      'mailing_address.state': 'NC',
      'mailing_address.zip': '28402',
    }
    expect(toFillMapping(flat)).toEqual({
      fein: '12-3456789',
      mailing_address: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' },
    })
  })

  it('expands bracketed indices into a dense, ordered array of objects', () => {
    const flat = {
      'claims[0].year': 2023, 'claims[0].amount': 30000,
      'claims[1].year': 2024, 'claims[1].amount': 15000,
    }
    expect(toFillMapping(flat)).toEqual({
      claims: [ { year: 2023, amount: 30000 }, { year: 2024, amount: 15000 } ],
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/forms/renderers.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/forms/bindings.ts`**

```ts
// src/forms/bindings.ts
import type { FormType } from '../schema/profile.js'

export interface StaticBinding { form_field_path: string; profile_field_path: string }

/** Scalar / fixed-object bindings. Same profile_field_path in two forms == shared field. */
export const STATIC_BINDINGS: Record<FormType, StaticBinding[]> = {
  acord_125: [
    { form_field_path: 'policyholder_first_name', profile_field_path: 'policyholder_first_name' },
    { form_field_path: 'policyholder_last_name', profile_field_path: 'policyholder_last_name' },
    { form_field_path: 'dba_name', profile_field_path: 'dba_name' },
    { form_field_path: 'entity_type', profile_field_path: 'entity_type' },
    { form_field_path: 'fein', profile_field_path: 'fein' },
    { form_field_path: 'annual_gross_revenue', profile_field_path: 'annual_gross_revenue' },
    { form_field_path: 'employee_count_full_time', profile_field_path: 'employee_count_full_time' },
    { form_field_path: 'employee_count_part_time', profile_field_path: 'employee_count_part_time' },
    { form_field_path: 'mailing_address.street', profile_field_path: 'mailing_address.street' },
    { form_field_path: 'mailing_address.city', profile_field_path: 'mailing_address.city' },
    { form_field_path: 'mailing_address.state', profile_field_path: 'mailing_address.state' },
    { form_field_path: 'mailing_address.zip', profile_field_path: 'mailing_address.zip' },
  ],
  acord_126: [
    // shared fields point at the SAME profile paths -> DRY
    { form_field_path: 'employee_count_full_time', profile_field_path: 'employee_count_full_time' },
    { form_field_path: 'employee_count_part_time', profile_field_path: 'employee_count_part_time' },
  ],
}

/** Collections a form expands positionally: form-array prefix -> profile collection name. */
export const COLLECTION_BINDINGS: Record<FormType, { form_prefix: string; collection: string; fields: string[] }[]> = {
  acord_125: [{ form_prefix: 'claims', collection: 'claims', fields: ['year', 'type', 'amount', 'description'] }],
  acord_126: [],
}
```

- [ ] **Step 4: Implement `src/forms/renderers.ts`**

```ts
// src/forms/renderers.ts
import type { Fact, FormType } from '../schema/profile.js'
import type { FieldBinding, FillMapping, FormMapping, JsonValue, RenderResult } from '../schema/forms.js'
import { STATIC_BINDINGS, COLLECTION_BINDINGS } from './bindings.js'

/** Effective value: a human-approved correction (reviewed_value_json) overrides the machine value. */
export function effectiveValueJson(f: Fact): string | null {
  return f.review_status === 'approved' && f.reviewed_value_json !== null ? f.reviewed_value_json : f.value_json
}
const val = (f: Fact | undefined): string | number | null => {
  if (!f) return null
  const raw = effectiveValueJson(f)
  return raw === null ? null : JSON.parse(raw)
}

/** Distinct item_ids present for a collection, sorted for deterministic positional order. */
function itemIdsFor(collection: string, facts: Map<string, Fact>): string[] {
  const ids = new Set<string>()
  for (const path of facts.keys()) {
    const m = path.match(new RegExp(`^${collection}\\.([^.]+)\\.`))
    if (m) ids.add(m[1]!)
  }
  return [...ids].sort()
}

export function renderForm(formType: FormType, facts: Map<string, Fact>): RenderResult {
  const mapping: FormMapping = {}
  const fieldBindings: FieldBinding[] = []

  for (const b of STATIC_BINDINGS[formType]) {
    mapping[b.form_field_path] = val(facts.get(b.profile_field_path))
    fieldBindings.push({ form_field_path: b.form_field_path, profile_field_path: b.profile_field_path })
  }

  for (const coll of COLLECTION_BINDINGS[formType]) {
    const ids = itemIdsFor(coll.collection, facts)
    ids.forEach((itemId, i) => {
      for (const field of coll.fields) {
        const formPath = `${coll.form_prefix}[${i}].${field}`
        const profilePath = `${coll.collection}.${itemId}.${field}`
        mapping[formPath] = val(facts.get(profilePath))
        fieldBindings.push({ form_field_path: formPath, profile_field_path: profilePath })
      }
    })
  }

  return { mapping, fieldBindings }
}

/** Reverse an ACORD field path to a profile path: array paths via per-draft bindings, scalars via static. */
export function reverseResolve(
  formType: FormType, formFieldPath: string, draftBindings: FieldBinding[],
): string | undefined {
  const perDraft = draftBindings.find(b => b.form_field_path === formFieldPath)
  if (perDraft) return perDraft.profile_field_path
  const stat = STATIC_BINDINGS[formType].find(b => b.form_field_path === formFieldPath)
  return stat?.profile_field_path
}

/** All profile field paths a form reads (scalars only; collections resolved per-draft). */
export function boundScalarPaths(formType: FormType): string[] {
  return STATIC_BINDINGS[formType].map(b => b.profile_field_path)
}

/**
 * Unflatten a FLAT review mapping into the NESTED shape the real `fill_form` service expects
 * (README): dotted keys (`mailing_address.street`) become nested objects and bracketed keys
 * (`claims[0].amount`) become arrays of objects, e.g.
 *   { fein, 'mailing_address.street': 'PO Box 9102', 'claims[0].amount': 30000 }
 *     -> { fein, mailing_address: { street: 'PO Box 9102' }, claims: [ { amount: 30000 } ] }
 * The flat mapping stays the human review surface + draft projection; this nested mapping is
 * what we persist as the outbox payload and hand to `fillForm`. Pure and deterministic — same
 * flat mapping always yields the same nested object. renderForm emits contiguous array indices
 * (0..n-1) in sorted item order, so arrays are dense and correctly ordered.
 */
export function toFillMapping(flat: FormMapping): FillMapping {
  const root: Record<string, JsonValue> = {}
  for (const [flatKey, value] of Object.entries(flat)) {
    // "claims[0].amount" -> ["claims", 0, "amount"]; "mailing_address.street" -> [..., "street"]
    const segments: (string | number)[] = []
    for (const part of flatKey.split('.')) {
      const m = part.match(/^(.+?)\[(\d+)\]$/)
      if (m) { segments.push(m[1]!, Number(m[2]!)) } else { segments.push(part) }
    }
    // Walk the path, materialising an array when the next segment is a numeric index else an object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutable heterogeneous cursor
    let cur: any = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      if (cur[seg] === undefined) cur[seg] = typeof segments[i + 1] === 'number' ? [] : {}
      cur = cur[seg]
    }
    cur[segments[segments.length - 1]!] = value
  }
  return root
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/forms/renderers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/forms/bindings.ts src/forms/renderers.ts tests/forms/renderers.test.ts
git commit -m "feat: form bindings + renderers with per-draft array bindings"
```

---

## Task 8: Evidence matcher

**Files:**
- Create: `src/extraction/evidenceMatcher.ts`
- Test: `tests/extraction/evidenceMatcher.test.ts`

**Interfaces:**
- Consumes: `MatchQuality` (Task 2).
- Produces: `locateEvidence(transcript: string, quote: string | null): { quality: MatchQuality; span: [number, number] | null }` — `exact` single hit → span; whitespace/case/punct-normalized single hit → `normalized` span; >1 hit → `ambiguous`, null span; no hit or null quote → `none`, null span.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extraction/evidenceMatcher.test.ts
import { describe, it, expect } from 'vitest'
import { locateEvidence } from '../../src/extraction/evidenceMatcher.js'

const T = 'We did about two and a half million last year. About two and a half million, roughly.'

describe('locateEvidence', () => {
  it('exact single match returns a span', () => {
    const r = locateEvidence('the FEIN is 12-3456789 okay', '12-3456789')
    expect(r.quality).toBe('exact')
    expect(r.span).not.toBeNull()
  })
  it('normalized match (case/whitespace) returns normalized', () => {
    const r = locateEvidence('Coastal   Roofing LLC', 'coastal roofing llc')
    expect(r.quality).toBe('normalized')
  })
  it('a quote appearing twice is ambiguous with null span', () => {
    const r = locateEvidence(T, 'about two and a half million')
    expect(r.quality).toBe('ambiguous')
    expect(r.span).toBeNull()
  })
  it('unfound quote is none', () => {
    expect(locateEvidence(T, 'four hundred trucks').quality).toBe('none')
  })
  it('null quote is none', () => {
    expect(locateEvidence(T, null).quality).toBe('none')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/extraction/evidenceMatcher.test.ts`
Expected: FAIL — cannot find `evidenceMatcher.js`.

- [ ] **Step 3: Implement `src/extraction/evidenceMatcher.ts`**

```ts
// src/extraction/evidenceMatcher.ts
import type { MatchQuality } from '../schema/profile.js'

export interface EvidenceLocation { quality: MatchQuality; span: [number, number] | null }

function allIndexes(haystack: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let i = haystack.indexOf(needle)
  while (i !== -1) { out.push(i); i = haystack.indexOf(needle, i + 1) }
  return out
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function locateEvidence(transcript: string, quote: string | null): EvidenceLocation {
  if (!quote) return { quality: 'none', span: null }

  const exact = allIndexes(transcript, quote)
  if (exact.length === 1) return { quality: 'exact', span: [exact[0]!, exact[0]! + quote.length] }
  if (exact.length > 1) return { quality: 'ambiguous', span: null }

  // Normalized pass: tokenize both, find normalized-substring occurrences.
  const normT = normalize(transcript)
  const normQ = normalize(quote)
  if (!normQ) return { quality: 'none', span: null }
  const normHits = allIndexes(normT, normQ)
  if (normHits.length === 1) {
    // Try to recover a real span via a loosened case-insensitive search; if that misses we
    // return a null span rather than a bogus [0,0] that would point at the transcript start.
    const approx = transcript.toLowerCase().indexOf(quote.toLowerCase().trim())
    const span: [number, number] | null = approx !== -1 ? [approx, approx + quote.trim().length] : null
    return { quality: 'normalized', span }
  }
  if (normHits.length > 1) return { quality: 'ambiguous', span: null }
  return { quality: 'none', span: null }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/extraction/evidenceMatcher.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extraction/evidenceMatcher.ts tests/extraction/evidenceMatcher.test.ts
git commit -m "feat: staged evidence matcher (exact/normalized/ambiguous/none)"
```

---

## Task 9: LlmClient interface + Mock + Extractor

**Files:**
- Create: `src/extraction/llmClient.ts`, `src/extraction/extractor.ts`
- Create: `tests/fixtures/llm/coastal_v1.json`
- Test: `tests/extraction/extractor.test.ts`

**Interfaces:**
- Consumes: `ExtractionEnvelope`, `Fact`, `EnvelopeField` (Task 2); `locateEvidence` (Task 8); `resolveItemId` (Task 6); `Clock`, `factIdFor` (Task 1).
- Produces:
  - `interface LlmClient { extract(transcript: string): Promise<ExtractionEnvelope> }`.
  - `class MockLlmClient implements LlmClient` (constructed with a canned envelope).
  - `class AiSdkLlmClient implements LlmClient` (uses `generateText` + `Output.object`; bounded retries).
  - `extractFacts(env: ExtractionEnvelope, ctx): Fact[]` where `ctx = { customerId, sourceId, sourceDate, transcript, clock, itemsRepo }`. Produces one candidate `Fact` per scalar field and per collection-item field, with `field_path` using resolved `item_id`, evidence span + `match_quality` from `locateEvidence`, `review_status` forced to `needs_review` when `match_quality ∈ {ambiguous, none}` and presence is `present`.

- [ ] **Step 1: Create canned LLM fixture `tests/fixtures/llm/coastal_v1.json`**

```json
{
  "policyholder_first_name": { "value": "Mike", "presence": "present", "confidence": 0.95, "evidence": "My name's Mike Torres" },
  "annual_gross_revenue": { "value": 2500000, "presence": "present", "confidence": 0.5, "evidence": "about two and a half million, maybe a little over" },
  "annual_payroll": { "value": null, "presence": "needs_follow_up", "confidence": 0.2, "evidence": "can I get back to you on that" },
  "employee_count_full_time": { "value": 35, "presence": "present", "confidence": 0.7, "evidence": "roughly 35 full-time guys" },
  "claims": [
    { "natural_key": "2023|workers_comp", "year": { "value": 2023, "presence": "present", "confidence": 0.6, "evidence": "fell off a ladder" }, "type": { "value": "workers_comp", "presence": "present", "confidence": 0.8, "evidence": "workers comp claim" }, "amount": { "value": 30000, "presence": "present", "confidence": 0.7, "evidence": "about $30,000" }, "description": { "value": "Crew lead fell off ladder, broke arm", "presence": "present", "confidence": 0.6, "evidence": "broke his arm pretty bad" } }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/extraction/extractor.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import fixture from '../fixtures/llm/coastal_v1.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { MockLlmClient } from '../../src/extraction/llmClient.js'
import { extractFacts } from '../../src/extraction/extractor.js'
import { ExtractionEnvelope } from '../../src/schema/profile.js'
import { FixedClock } from '../../src/clock.js'

describe('extractFacts', () => {
  let db: DB, itemsRepo: CollectionItemsRepo
  const clock = new FixedClock('2025-03-12T10:30:00Z')
  const transcript = "My name's Mike Torres. about two and a half million, maybe a little over. roughly 35 full-time guys. about $30,000."
  beforeEach(() => { db = openDb(); migrate(db); itemsRepo = new CollectionItemsRepo(db) })

  it('produces a scalar fact with a resolved evidence span', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const rev = facts.find(f => f.field_path === 'annual_gross_revenue')!
    expect(rev.value_json).toBe('2500000')
    expect(rev.presence).toBe('present')
  })

  it('keys collection-item facts by resolved item_id, not array index', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const amount = facts.find(f => f.field_path.startsWith('claims.') && f.field_path.endsWith('.amount'))!
    expect(amount.field_path).toMatch(/^claims\.[a-f0-9]{24}\.amount$/)
    expect(amount.value_json).toBe('30000')
  })

  it('forces needs_review when a present value has an unlocatable quote', () => {
    const env = ExtractionEnvelope.parse({
      fein: { value: '99-9999999', presence: 'present', confidence: 0.9, evidence: 'not in the transcript at all' },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const fein = facts.find(f => f.field_path === 'fein')!
    expect(fein.match_quality).toBe('none')
    expect(fein.review_status).toBe('needs_review')
  })

  it('flattens a fixed nested object into leaf facts matching the form bindings', () => {
    const env = ExtractionEnvelope.parse({
      mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
    })
    const facts = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript: 'PO Box 9102, Wilmington, NC 28402', clock, itemsRepo })
    expect(facts.find(f => f.field_path === 'mailing_address.street')!.value_json).toBe('"PO Box 9102"')
    expect(facts.find(f => f.field_path === 'mailing_address.zip')!.value_json).toBe('"28402"')
    expect(facts.find(f => f.field_path === 'mailing_address')).toBeUndefined() // no whole-object fact
  })

  it('uses a deterministic id so reprocessing the same source does not fork facts', () => {
    const env = ExtractionEnvelope.parse(fixture)
    const a = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const b = extractFacts(env, { customerId: 'c1', sourceId: 's1', sourceDate: '2025-03-12T10:30:00Z', transcript, clock, itemsRepo })
    const idOf = (fs: typeof a, p: string) => fs.find(f => f.field_path === p)!.id
    expect(idOf(a, 'annual_gross_revenue')).toBe(idOf(b, 'annual_gross_revenue'))
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/extraction/extractor.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 4: Implement `src/extraction/llmClient.ts`**

```ts
// src/extraction/llmClient.ts
import { generateText, Output } from 'ai'
import { openai } from '@ai-sdk/openai'
import { ExtractionEnvelope } from '../schema/profile.js'

export interface LlmClient { extract(transcript: string): Promise<ExtractionEnvelope> }

/** Deterministic test double — returns a canned, schema-validated envelope. */
export class MockLlmClient implements LlmClient {
  constructor(private canned: unknown) {}
  async extract(_transcript: string): Promise<ExtractionEnvelope> {
    return ExtractionEnvelope.parse(this.canned)
  }
}

const PROMPT = (t: string) =>
  `Extract the business insurance facts from this call transcript. For every field set ` +
  `presence to present/missing/needs_follow_up/not_applicable, give a 0..1 confidence, and ` +
  `quote the verbatim supporting text in "evidence" (null when missing). Do not guess.\n\n${t}`

/** Real provider via the current AI SDK structured-output API, with bounded retries. */
export class AiSdkLlmClient implements LlmClient {
  constructor(private model = openai('gpt-5.2'), private maxRetries = 2) {}
  async extract(transcript: string): Promise<ExtractionEnvelope> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { output } = await generateText({
          model: this.model,
          output: Output.object({ schema: ExtractionEnvelope }),
          prompt: PROMPT(transcript),
        })
        return output
      } catch (e) { lastErr = e }
    }
    throw lastErr
  }
}
```

- [ ] **Step 5: Implement `src/extraction/extractor.ts`**

```ts
// src/extraction/extractor.ts
import type { Clock } from '../clock.js'
import type { CollectionItemsRepo } from '../db/repos/collectionItems.js'
import type { ExtractionEnvelope, Fact, EnvelopeField, MatchQuality, Presence } from '../schema/profile.js'
import { locateEvidence } from './evidenceMatcher.js'
import { resolveItemId } from '../profile/collectionIdentity.js'
import { factIdFor } from '../util/hash.js'

export interface ExtractCtx {
  customerId: string
  sourceId: string
  sourceDate: string
  transcript: string
  clock: Clock
  itemsRepo: CollectionItemsRepo
}

/** Build one Fact at a leaf field_path with a concrete leaf value + the envelope's provenance. */
function leafFact(fieldPath: string, leafValue: unknown, ef: EnvelopeField<unknown>, ctx: ExtractCtx): Fact {
  const loc = locateEvidence(ctx.transcript, ef.evidence)
  return {
    id: factIdFor(ctx.customerId, fieldPath, ctx.sourceId), // deterministic -> idempotent reprocessing
    customer_id: ctx.customerId,
    field_path: fieldPath,
    value_json: leafValue === null || leafValue === undefined ? null : JSON.stringify(leafValue),
    presence: ef.presence as Presence,
    confidence: ef.confidence,
    evidence_quote: ef.evidence,
    evidence_span_start: loc.span ? loc.span[0] : null,
    evidence_span_end: loc.span ? loc.span[1] : null,
    match_quality: loc.quality as MatchQuality,
    source_id: ctx.sourceId,
    source_date: ctx.sourceDate,
    extracted_at: ctx.clock.now(),
    // All machine facts start needs_review; ambiguous/none is surfaced to reviewers via match_quality.
    review_status: 'needs_review',
    reviewed_value_json: null, reviewed_by: null, reviewed_at: null, superseded_by: null,
  }
}

const isEnvelope = (v: unknown): v is EnvelopeField<unknown> =>
  typeof v === 'object' && v !== null && 'presence' in v && 'confidence' in v

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Emit facts for one envelope field. A scalar value -> one fact at `key`. A fixed nested
 * object value (e.g. mailing_address {street,city,...}) -> one LEAF fact per key
 * (`mailing_address.street`, ...) so paths line up with the form bindings. A `missing`
 * object (value null) emits nothing — the reconciler materializes the missing leaf rows.
 */
function emitEnvelope(key: string, ef: EnvelopeField<unknown>, ctx: ExtractCtx, out: Fact[]): void {
  if (isPlainObject(ef.value)) {
    for (const [leaf, leafVal] of Object.entries(ef.value)) {
      out.push(leafFact(`${key}.${leaf}`, leafVal, ef, ctx))
    }
  } else {
    out.push(leafFact(key, ef.value, ef, ctx))
  }
}

/** Flatten a validated envelope into candidate facts (scalars, nested-object leaves, collection items). */
export function extractFacts(env: ExtractionEnvelope, ctx: ExtractCtx): Fact[] {
  const facts: Fact[] = []
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) continue
    if (Array.isArray(val)) {
      for (const item of val as Array<Record<string, unknown> & { natural_key: string }>) {
        const itemId = resolveItemId(ctx.itemsRepo, ctx.clock, ctx.customerId, key, item.natural_key)
        for (const [field, ef] of Object.entries(item)) {
          if (field === 'natural_key' || !isEnvelope(ef)) continue
          emitEnvelope(`${key}.${itemId}.${field}`, ef, ctx, facts)
        }
      }
    } else if (isEnvelope(val)) {
      emitEnvelope(key, val, ctx, facts)
    }
  }
  return facts
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/extraction/extractor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/extraction/llmClient.ts src/extraction/extractor.ts tests/extraction/extractor.test.ts tests/fixtures/llm
git commit -m "feat: LlmClient (mock+aisdk) and fact extractor"
```

---

## Task 10: Facts repo + reconciler (materialize missing, write conflicts)

**Files:**
- Create: `src/db/repos/facts.ts`, `src/profile/reconciler.ts`
- Test: `tests/profile/reconciler.test.ts`

**Interfaces:**
- Consumes: `DB`, `Fact` (Task 2), `selectCurrentFact` (Task 5), `boundScalarPaths` (Task 7), `Clock`, `factIdFor` (Task 1).
- Produces:
  - `class FactsRepo { insertMany(facts: Fact[]): void; byField(customerId, fieldPath): Fact[]; currentMap(customerId): Map<string,Fact>; allFieldPaths(customerId): string[]; markApproved(id, value, by, at): void; supersede(id, by): void }`.
  - `class ConflictsRepo { insert(...); listUnresolved(customerId): ConflictRow[]; resolve(id, by, at): void }`.
  - `reconcile(ctx): void` — for each field, pick current via `selectCurrentFact`; if a newer machine candidate disagrees with an approved current, write an unresolved `conflicts` row; then materialize `presence:'missing'` facts for any bound scalar path with no fact.

- [ ] **Step 1: Write the failing test**

```ts
// tests/profile/reconciler.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { reconcile } from '../../src/profile/reconciler.js'
import { FixedClock } from '../../src/clock.js'
import type { Fact } from '../../src/schema/profile.js'

function fact(o: Partial<Fact>): Fact {
  return {
    id: Math.random().toString(36).slice(2), customer_id: 'c1', field_path: 'annual_gross_revenue',
    value_json: '2500000', presence: 'present', confidence: 0.5, evidence_quote: null,
    evidence_span_start: null, evidence_span_end: null, match_quality: 'exact', source_id: 's1',
    source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    review_status: 'needs_review', reviewed_value_json: null, reviewed_by: null, reviewed_at: null,
    superseded_by: null, ...o,
  }
}

describe('reconcile', () => {
  let db: DB, facts: FactsRepo, conflicts: ConflictsRepo
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  beforeEach(() => { db = openDb(); migrate(db); facts = new FactsRepo(db); conflicts = new ConflictsRepo(db) })

  it('writes a conflict when a newer machine fact disagrees with an approved one', () => {
    facts.insertMany([
      fact({ id: 'a', review_status: 'approved', value_json: '2500000', source_date: '2025-03-12T00:00:00Z' }),
      fact({ id: 'b', review_status: 'needs_review', value_json: '2800000', source_date: '2025-03-15T00:00:00Z' }),
    ])
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const open = conflicts.listUnresolved('c1')
    expect(open).toHaveLength(1)
    expect(open[0]!.current_fact_id).toBe('a')
    expect(open[0]!.conflicting_fact_id).toBe('b')
  })

  it('materializes a missing fact for bound fields never mentioned', () => {
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    const fein = facts.byField('c1', 'fein')
    expect(fein).toHaveLength(1)
    expect(fein[0]!.presence).toBe('missing')
    expect(fein[0]!.value_json).toBeNull()
  })

  it('does not duplicate a missing fact on a second reconcile', () => {
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    reconcile({ db, facts, conflicts, clock, customerId: 'c1', formTypes: ['acord_125'] })
    expect(facts.byField('c1', 'fein')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/profile/reconciler.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/db/repos/facts.ts`**

```ts
// src/db/repos/facts.ts
import type { DB } from '../sqlite.js'
import type { Fact } from '../../schema/profile.js'
import { selectCurrentFact } from '../../profile/factSelector.js'

export class FactsRepo {
  constructor(private db: DB) {}

  insertMany(facts: Fact[]): void {
    // OR IGNORE: fact ids are deterministic per (customer, field_path, source_id), so
    // re-extracting the same source is idempotent and never clobbers a human-approved row.
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO facts
      (id,customer_id,field_path,value_json,presence,confidence,evidence_quote,evidence_span_start,
       evidence_span_end,match_quality,source_id,source_date,extracted_at,review_status,
       reviewed_value_json,reviewed_by,reviewed_at,superseded_by)
      VALUES (@id,@customer_id,@field_path,@value_json,@presence,@confidence,@evidence_quote,
       @evidence_span_start,@evidence_span_end,@match_quality,@source_id,@source_date,@extracted_at,
       @review_status,@reviewed_value_json,@reviewed_by,@reviewed_at,@superseded_by)`)
    const tx = this.db.transaction((rows: Fact[]) => { for (const r of rows) stmt.run(r) })
    tx(facts)
  }

  byField(customerId: string, fieldPath: string): Fact[] {
    return this.db.prepare('SELECT * FROM facts WHERE customer_id=? AND field_path=?')
      .all(customerId, fieldPath) as Fact[]
  }

  allFieldPaths(customerId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT field_path FROM facts WHERE customer_id=?')
      .all(customerId) as { field_path: string }[]).map(r => r.field_path)
  }

  /** field_path -> current Fact (per selectCurrentFact). */
  currentMap(customerId: string): Map<string, Fact> {
    const all = this.db.prepare('SELECT * FROM facts WHERE customer_id=? AND superseded_by IS NULL')
      .all(customerId) as Fact[]
    const byPath = new Map<string, Fact[]>()
    for (const f of all) { (byPath.get(f.field_path) ?? byPath.set(f.field_path, []).get(f.field_path)!).push(f) }
    const out = new Map<string, Fact>()
    for (const [path, cands] of byPath) { const cur = selectCurrentFact(cands); if (cur) out.set(path, cur) }
    return out
  }

  /**
   * Approve a fact, optionally overriding its value (a human correction). Does NOT change
   * `presence`: approving a non-present fact with `reviewedValueJson=null` yields the
   * `approved_blank` read state (sign-off on leaving it blank). Reviewer-initiated
   * present→not_applicable is a deferred extension — see Explicit Scope / Deferrals.
   */
  markApproved(id: string, reviewedValueJson: string | null, by: string, at: string): void {
    this.db.prepare(`UPDATE facts SET review_status='approved', reviewed_value_json=?, reviewed_by=?, reviewed_at=? WHERE id=?`)
      .run(reviewedValueJson, by, at, id)
  }

  /** Mark a fact superseded (reserved for explicit ledger tombstoning; selection ignores these). */
  supersede(id: string, by: string): void {
    this.db.prepare('UPDATE facts SET superseded_by=? WHERE id=?').run(by, id)
  }

  get(id: string): Fact | undefined {
    return this.db.prepare('SELECT * FROM facts WHERE id=?').get(id) as Fact | undefined
  }
}
```

- [ ] **Step 4: Implement `src/db/repos/conflicts.ts`**

```ts
// src/db/repos/conflicts.ts
import type { DB } from '../sqlite.js'
import { newId } from '../../util/id.js'

export interface ConflictRow {
  id: string; customer_id: string; field_path: string; current_fact_id: string
  conflicting_fact_id: string; status: 'unresolved' | 'resolved'; resolved_by: string | null
  resolved_at: string | null; created_at: string
}

export class ConflictsRepo {
  constructor(private db: DB) {}
  existsOpen(customerId: string, conflictingFactId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM conflicts WHERE customer_id=? AND conflicting_fact_id=? AND status='unresolved'`
    ).get(customerId, conflictingFactId)
  }
  insert(customerId: string, fieldPath: string, currentFactId: string, conflictingFactId: string, now: string): void {
    this.db.prepare(`INSERT INTO conflicts (id,customer_id,field_path,current_fact_id,conflicting_fact_id,status,created_at)
      VALUES (?,?,?,?,?, 'unresolved', ?)`).run(newId(), customerId, fieldPath, currentFactId, conflictingFactId, now)
  }
  listUnresolved(customerId: string): ConflictRow[] {
    return this.db.prepare(`SELECT * FROM conflicts WHERE customer_id=? AND status='unresolved'`).all(customerId) as ConflictRow[]
  }
  resolve(id: string, by: string, at: string): void {
    this.db.prepare(`UPDATE conflicts SET status='resolved', resolved_by=?, resolved_at=? WHERE id=?`).run(by, at, id)
  }
}
```

- [ ] **Step 5: Implement `src/profile/reconciler.ts`**

```ts
// src/profile/reconciler.ts
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { ConflictsRepo } from '../db/repos/conflicts.js'
import type { Fact, FormType } from '../schema/profile.js'
import { selectCurrentFact } from './factSelector.js'
import { boundScalarPaths } from '../forms/renderers.js'
import { factIdFor } from '../util/hash.js'

export interface ReconcileCtx {
  db: DB; facts: FactsRepo; conflicts: ConflictsRepo; clock: Clock
  customerId: string; formTypes: FormType[]
}

export function reconcile(ctx: ReconcileCtx): void {
  const { facts, conflicts, clock, customerId } = ctx
  const now = clock.now()

  // 1. Conflict detection per field: an approved current + a newer machine candidate that disagrees.
  for (const fieldPath of facts.allFieldPaths(customerId)) {
    const cands = facts.byField(customerId, fieldPath).filter(f => f.superseded_by === null)
    const current = selectCurrentFact(cands)
    if (!current || current.review_status !== 'approved') continue
    for (const c of cands) {
      if (c.id === current.id || c.review_status === 'approved') continue
      const disagrees = c.value_json !== (current.reviewed_value_json ?? current.value_json)
      const isNewer = c.source_date > current.source_date
      if (disagrees && isNewer && !conflicts.existsOpen(customerId, c.id)) {
        conflicts.insert(customerId, fieldPath, current.id, c.id, now)
      }
    }
  }

  // 2. Materialize a missing fact for every bound scalar path with no fact yet.
  const known = new Set(facts.allFieldPaths(customerId))
  const missing: Fact[] = []
  const bound = new Set(ctx.formTypes.flatMap(ft => boundScalarPaths(ft)))
  for (const path of bound) {
    if (known.has(path)) continue
    missing.push({
      id: factIdFor(customerId, path, 'system'), customer_id: customerId, field_path: path, value_json: null,
      presence: 'missing', confidence: 0, evidence_quote: null, evidence_span_start: null,
      evidence_span_end: null, match_quality: 'none', source_id: 'system', source_date: now,
      extracted_at: now, review_status: 'needs_review', reviewed_value_json: null,
      reviewed_by: null, reviewed_at: null, superseded_by: null,
    })
  }
  if (missing.length) facts.insertMany(missing)
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/profile/reconciler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/facts.ts src/db/repos/conflicts.ts src/profile/reconciler.ts tests/profile/reconciler.test.ts
git commit -m "feat: facts/conflicts repos + reconciler (missing rows + conflicts)"
```

---

## Task 11: Blob store + fillForm stub

**Files:**
- Create: `src/blob/blobStore.ts`, `src/forms/fillForm.ts`
- Test: `tests/forms/fillForm.test.ts`

**Interfaces:**
- Consumes: `FormType`, `FormMapping` (Task 2); `contentHash` (Task 1).
- Produces:
  - `interface BlobStore { put(key: string, bytes: Buffer): Promise<void>; get(key: string): Promise<Buffer | null> }`; `class MemoryBlobStore implements BlobStore`.
  - `fillForm(formType, mapping, blob): Promise<{ pdf_ref: string; content_hash: string }>` — deterministic key `pdf/{customerId?}/{formType}/{hash}`; here keyed by `pdf/{formType}/{contentHash}` (customer folded into mapping-derived hash context by caller). Stub bytes = JSON of mapping.

- [ ] **Step 1: Write the failing test**

```ts
// tests/forms/fillForm.test.ts
import { describe, it, expect } from 'vitest'
import { fillForm } from '../../src/forms/fillForm.js'
import { MemoryBlobStore } from '../../src/blob/blobStore.js'

describe('fillForm', () => {
  it('writes to a deterministic key derived from content', async () => {
    const blob = new MemoryBlobStore()
    const r1 = await fillForm('c1', 'acord_125', { fein: '12-3456789' }, blob)
    const r2 = await fillForm('c1', 'acord_125', { fein: '12-3456789' }, blob)
    expect(r1.pdf_ref).toBe(r2.pdf_ref)               // idempotent key
    expect(await blob.get(r1.pdf_ref)).not.toBeNull()
  })
  it('different content -> different key', async () => {
    const blob = new MemoryBlobStore()
    const a = await fillForm('c1', 'acord_125', { fein: 'A' }, blob)
    const b = await fillForm('c1', 'acord_125', { fein: 'B' }, blob)
    expect(a.pdf_ref).not.toBe(b.pdf_ref)
  })
  it('persists the nested fill_form contract shape verbatim (objects + arrays)', async () => {
    const blob = new MemoryBlobStore()
    const fill = {
      fein: '12-3456789',
      mailing_address: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' },
      claims: [ { year: 2023, amount: 30000 } ],
    }
    const r = await fillForm('c1', 'acord_125', fill, blob)
    const stored = JSON.parse((await blob.get(r.pdf_ref))!.toString())
    expect(stored.mapping).toEqual(fill)   // nested structure round-trips into the "PDF"
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/forms/fillForm.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/blob/blobStore.ts`**

```ts
// src/blob/blobStore.ts
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  get(key: string): Promise<Buffer | null>
}

export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, Buffer>()
  async put(key: string, bytes: Buffer): Promise<void> { this.m.set(key, bytes) }
  async get(key: string): Promise<Buffer | null> { return this.m.get(key) ?? null }
}
```

- [ ] **Step 4: Implement `src/forms/fillForm.ts`**

```ts
// src/forms/fillForm.ts
import type { FormType } from '../schema/profile.js'
import type { FillMapping } from '../schema/forms.js'
import type { BlobStore } from '../blob/blobStore.js'
import { contentHash } from '../util/hash.js'

/**
 * Stub for the real form-filling service. Receives the NESTED fill mapping (the README
 * `fill_form` contract shape, built via `toFillMapping`) — not the flat review mapping.
 * Produces "PDF bytes" (the JSON mapping) and stores them at a deterministic,
 * content-addressed key so retries are idempotent.
 */
export async function fillForm(
  customerId: string, formType: FormType, mapping: FillMapping, blob: BlobStore,
): Promise<{ pdf_ref: string; content_hash: string }> {
  const hash = contentHash({ customerId, formType, mapping })
  const pdf_ref = `pdf/${customerId}/${formType}/${hash}`
  await blob.put(pdf_ref, Buffer.from(JSON.stringify({ formType, mapping }, null, 2)))
  return { pdf_ref, content_hash: hash }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/forms/fillForm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/blob/blobStore.ts src/forms/fillForm.ts tests/forms/fillForm.test.ts
git commit -m "feat: blob store + deterministic fillForm stub"
```

---

## Task 12: Drafts + Outbox repos

**Files:**
- Create: `src/db/repos/drafts.ts`, `src/db/repos/outbox.ts`
- Test: `tests/db/repos.test.ts`

**Interfaces:**
- Consumes: `DB`, `FormType`, `FieldBinding`, `newId`.
- Produces:
  - `class DraftsRepo { current(customerId, formType): DraftRow | undefined; upsertProjection(...): DraftRow; saveBindings(draftId, bindings): void; getBindings(draftId): FieldBinding[]; approve(draftId, by, at): void; markFilled(draftId, pdfRef, at): void; supersede(draftId, byRevision): void; newRevision(...): DraftRow }`.
  - `class OutboxRepo { enqueue(...): string; pendingForForm(customerId, formType): OutboxRow | undefined; cancel(id): void; get(id): OutboxRow | undefined }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/repos.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'

describe('DraftsRepo + OutboxRepo', () => {
  let db: DB, drafts: DraftsRepo, outbox: OutboxRepo
  beforeEach(() => { db = openDb(); migrate(db); drafts = new DraftsRepo(db); outbox = new OutboxRepo(db) })

  it('creates revision 1 then a new revision that supersedes the old', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    expect(r1.revision).toBe(1)
    drafts.markFilled(r1.id, 'pdf/x', '2025-01-01T00:01:00Z')
    const r2 = drafts.newRevision('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(2)
    const oldRow = drafts.byId(r1.id)!
    expect(oldRow.status).toBe('filled')                       // stays filled
    expect(oldRow.superseded_by_revision).toBe(2)              // recorded separately
    expect(drafts.current('c1', 'acord_125')!.revision).toBe(2)
  })

  it('upsertProjection over a FILLED draft mints a new revision and supersedes the old', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    drafts.markFilled(r1.id, 'pdf/x', '2025-01-01T00:01:00Z')
    // A later transcript reprojects the SAME form via upsertProjection (not newRevision).
    const r2 = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(2)
    expect(r2.status).toBe('needs_review')                     // must be re-reviewed
    expect(drafts.byId(r1.id)!.status).toBe('filled')          // old stays filled (immutable)
    expect(drafts.byId(r1.id)!.superseded_by_revision).toBe(2) // no dangling current row
    // Exactly one current row for the (customer, form).
    const currentRows = db.prepare(
      "SELECT COUNT(*) n FROM form_drafts WHERE customer_id='c1' AND form_type='acord_125' AND superseded_by_revision IS NULL"
    ).get() as { n: number }
    expect(currentRows.n).toBe(1)
  })

  it('upsertProjection over a non-filled draft overwrites in place (same revision)', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-01-01T00:00:00Z')
    drafts.approve(r1.id, 'sarah', '2025-01-01T00:00:30Z')
    const r2 = drafts.upsertProjection('c1', 'acord_125', { fein: 'B' }, '2025-01-02T00:00:00Z')
    expect(r2.revision).toBe(1)                                 // same row
    expect(r2.status).toBe('needs_review')                     // approval invalidated by new data
    expect(JSON.parse(r2.projected_json).fein).toBe('B')
  })

  it('enqueues and finds a pending outbox row, then cancels it', () => {
    const id = outbox.enqueue('c1', 'acord_125', 1, { fein: 'A' }, 'hash', '2025-01-01T00:00:00Z')
    expect(outbox.pendingForForm('c1', 'acord_125')!.id).toBe(id)
    outbox.cancel(id)
    expect(outbox.pendingForForm('c1', 'acord_125')).toBeUndefined()
    expect(outbox.get(id)!.status).toBe('cancelled')
  })

  it('persists and reads per-draft field bindings', () => {
    const r1 = drafts.upsertProjection('c1', 'acord_125', {}, '2025-01-01T00:00:00Z')
    drafts.saveBindings(r1.id, [{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.abc.amount' }])
    expect(drafts.getBindings(r1.id)).toEqual([{ form_field_path: 'claims[0].amount', profile_field_path: 'claims.abc.amount' }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/repos.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/db/repos/drafts.ts`**

```ts
// src/db/repos/drafts.ts
import type { DB } from '../sqlite.js'
import type { FormType } from '../../schema/profile.js'
import type { FieldBinding, FormMapping } from '../../schema/forms.js'
import { newId } from '../../util/id.js'

export interface DraftRow {
  id: string; customer_id: string; form_type: string; revision: number; projected_json: string
  status: 'needs_review' | 'approved' | 'filled'; approved_by: string | null; approved_at: string | null
  pdf_ref: string | null; superseded_by_revision: number | null; created_at: string; updated_at: string
}

export class DraftsRepo {
  constructor(private db: DB) {}

  byId(id: string): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM form_drafts WHERE id=?').get(id) as DraftRow | undefined
  }

  current(customerId: string, formType: FormType): DraftRow | undefined {
    return this.db.prepare(
      `SELECT * FROM form_drafts WHERE customer_id=? AND form_type=? AND superseded_by_revision IS NULL
       ORDER BY revision DESC LIMIT 1`
    ).get(customerId, formType) as DraftRow | undefined
  }

  private maxRevision(customerId: string, formType: FormType): number {
    const r = this.db.prepare('SELECT MAX(revision) m FROM form_drafts WHERE customer_id=? AND form_type=?')
      .get(customerId, formType) as { m: number | null }
    return r.m ?? 0
  }

  /**
   * Reproject the current draft from fresh facts.
   *  - no current row → create revision 1.
   *  - current is 'filled' → a filled draft is IMMUTABLE (its PDF may be at a carrier), so we
   *    mint a new needs_review revision and mark the old row superseded. Routed through
   *    newRevision() so `superseded_by_revision` is always set — never a dangling filled row
   *    with `superseded_by_revision IS NULL` (which would break the single-current invariant).
   *  - current is needs_review/approved (not yet filled) → overwrite its projection in place
   *    and reset to needs_review; new data invalidates any prior approval, so it re-reviews.
   */
  upsertProjection(customerId: string, formType: FormType, mapping: FormMapping, now: string): DraftRow {
    const cur = this.current(customerId, formType)
    if (!cur) return this.insert(customerId, formType, 1, mapping, now)
    if (cur.status === 'filled') return this.newRevision(customerId, formType, mapping, now)
    this.db.prepare('UPDATE form_drafts SET projected_json=?, status=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(mapping), 'needs_review', now, cur.id)
    return this.byId(cur.id)!
  }

  newRevision(customerId: string, formType: FormType, mapping: FormMapping, now: string): DraftRow {
    const cur = this.current(customerId, formType)
    const next = this.maxRevision(customerId, formType) + 1
    const row = this.insert(customerId, formType, next, mapping, now)
    if (cur) this.supersede(cur.id, next)
    return row
  }

  private insert(customerId: string, formType: FormType, revision: number, mapping: FormMapping, now: string): DraftRow {
    const id = newId()
    this.db.prepare(`INSERT INTO form_drafts (id,customer_id,form_type,revision,projected_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'needs_review',?,?)`).run(id, customerId, formType, revision, JSON.stringify(mapping), now, now)
    return this.byId(id)!
  }

  approve(draftId: string, by: string, at: string): void {
    this.db.prepare(`UPDATE form_drafts SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?`)
      .run(by, at, at, draftId)
  }
  markFilled(draftId: string, pdfRef: string, at: string): void {
    this.db.prepare(`UPDATE form_drafts SET status='filled', pdf_ref=?, updated_at=? WHERE id=?`).run(pdfRef, at, draftId)
  }
  supersede(draftId: string, byRevision: number): void {
    this.db.prepare('UPDATE form_drafts SET superseded_by_revision=? WHERE id=?').run(byRevision, draftId)
  }

  saveBindings(draftId: string, bindings: FieldBinding[]): void {
    const del = this.db.prepare('DELETE FROM draft_field_bindings WHERE draft_id=?')
    const ins = this.db.prepare('INSERT INTO draft_field_bindings (draft_id,form_field_path,profile_field_path) VALUES (?,?,?)')
    const tx = this.db.transaction(() => { del.run(draftId); for (const b of bindings) ins.run(draftId, b.form_field_path, b.profile_field_path) })
    tx()
  }
  getBindings(draftId: string): FieldBinding[] {
    return this.db.prepare('SELECT form_field_path, profile_field_path FROM draft_field_bindings WHERE draft_id=?')
      .all(draftId) as FieldBinding[]
  }
}
```

- [ ] **Step 4: Implement `src/db/repos/outbox.ts`**

```ts
// src/db/repos/outbox.ts
import type { DB } from '../sqlite.js'
import type { FormType } from '../../schema/profile.js'
import type { FillMapping } from '../../schema/forms.js'
import { newId } from '../../util/id.js'

export interface OutboxRow {
  id: string; customer_id: string; form_type: string; draft_revision: number; payload_json: string
  content_hash: string; status: string; attempts: number; next_attempt_at: string
  locked_until: string | null; lock_token: string | null; locked_by: string | null; created_at: string
}

export class OutboxRepo {
  constructor(private db: DB) {}
  // `mapping` is the NESTED fill mapping (README fill_form shape), not the flat review mapping;
  // it is stored verbatim as payload_json and handed to fillForm by the worker.
  enqueue(customerId: string, formType: FormType, draftRevision: number, mapping: FillMapping, contentHash: string, now: string): string {
    const id = newId()
    this.db.prepare(`INSERT INTO outbox (id,customer_id,form_type,draft_revision,payload_json,content_hash,status,attempts,next_attempt_at,created_at)
      VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`).run(id, customerId, formType, draftRevision, JSON.stringify(mapping), contentHash, now, now)
    return id
  }
  pendingForForm(customerId: string, formType: FormType): OutboxRow | undefined {
    return this.db.prepare(
      `SELECT * FROM outbox WHERE customer_id=? AND form_type=? AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1`
    ).get(customerId, formType) as OutboxRow | undefined
  }
  cancel(id: string): void {
    this.db.prepare(`UPDATE outbox SET status='cancelled', locked_until=NULL, lock_token=NULL WHERE id=? AND status IN ('pending','processing')`).run(id)
  }
  get(id: string): OutboxRow | undefined {
    return this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as OutboxRow | undefined
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/db/repos.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/drafts.ts src/db/repos/outbox.ts tests/db/repos.test.ts
git commit -m "feat: drafts (revisions+bindings) and outbox repos"
```

---

## Task 13: ReviewClient (approveForm + conflicts)

**Files:**
- Create: `src/review/reviewClient.ts`
- Test: `tests/review/reviewClient.test.ts`

**Interfaces:**
- Consumes: `DB`, `FactsRepo`, `DraftsRepo`, `OutboxRepo`, `ConflictsRepo`, `renderForm`, `reverseResolve`, `fillForm`-content-hash via `contentHash`, `Clock`.
- Produces: `class ReviewClient` with:
  - `getDraft(customerId, formType): { draft, fields: {formFieldPath, value, provenance}[] }`
  - `listUnresolvedConflicts(customerId): ConflictRow[]`
  - `resolveConflict(id, by): void`
  - `approveForm(customerId, formType, opts?: { edits?: Record<string, unknown>; by?: string }): { draftId, revision, outboxId }` — one txn: reverse-resolve edits, apply, approve **all** form-bound current facts, re-project + persist bindings, supersede any pending/processing/filled predecessor (new revision), enqueue outbox. Calls the injected `onEnqueued` hook after commit (wake-on-commit).

- [ ] **Step 1: Write the failing test**

```ts
// tests/review/reviewClient.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { ReviewClient } from '../../src/review/reviewClient.js'
import { FixedClock } from '../../src/clock.js'
import type { Fact } from '../../src/schema/profile.js'

function seedFact(facts: FactsRepo, field_path: string, value: unknown, review_status: Fact['review_status'] = 'needs_review') {
  facts.insertMany([{
    id: field_path, customer_id: 'c1', field_path, value_json: JSON.stringify(value), presence: 'present',
    confidence: 0.9, evidence_quote: 'q', evidence_span_start: 0, evidence_span_end: 1, match_quality: 'exact',
    source_id: 's1', source_date: '2025-03-12T00:00:00Z', extracted_at: '2025-03-12T00:00:00Z',
    review_status, reviewed_value_json: null, reviewed_by: null, reviewed_at: null, superseded_by: null,
  }])
}

describe('ReviewClient.approveForm', () => {
  let db: DB, facts: FactsRepo, drafts: DraftsRepo, outbox: OutboxRepo, conflicts: ConflictsRepo, rc: ReviewClient
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  const wake = vi.fn()
  beforeEach(() => {
    db = openDb(); migrate(db)
    facts = new FactsRepo(db); drafts = new DraftsRepo(db); outbox = new OutboxRepo(db); conflicts = new ConflictsRepo(db)
    rc = new ReviewClient({ db, facts, drafts, outbox, conflicts, clock, formTypes: ['acord_125', 'acord_126'], onEnqueued: wake })
    seedFact(facts, 'policyholder_first_name', 'Mike')
    seedFact(facts, 'annual_gross_revenue', 2500000)
    drafts.upsertProjection('c1', 'acord_125', { policyholder_first_name: 'Mike', annual_gross_revenue: 2500000 }, '2025-03-15T00:00:00Z')
  })

  it('applies an edit, approves ALL form-bound facts, and the EDIT reaches the outbox payload', () => {
    const res = rc.approveForm('c1', 'acord_125', { edits: { annual_gross_revenue: 2800000 }, by: 'sarah' })
    // edited fact reflects new value + approved
    expect(JSON.parse(facts.byField('c1', 'annual_gross_revenue')[0]!.reviewed_value_json!)).toBe(2800000)
    // an untouched, form-bound fact is ALSO approved
    expect(facts.byField('c1', 'policyholder_first_name')[0]!.review_status).toBe('approved')
    // the correction actually lands in the projected draft AND the outbox payload (not the stale 2.5M)
    expect(JSON.parse(outbox.get(res.outboxId)!.payload_json).annual_gross_revenue).toBe(2800000)
    expect(JSON.parse(drafts.byId(res.draftId)!.projected_json).annual_gross_revenue).toBe(2800000)
    expect(outbox.get(res.outboxId)!.status).toBe('pending')
    expect(wake).toHaveBeenCalledOnce()
  })

  it('ripples a shared-field edit to a filled OTHER form as a new needs_review revision', () => {
    // employee_count_full_time is bound in BOTH 125 and 126.
    seedFact(facts, 'employee_count_full_time', 35)
    const d126 = drafts.upsertProjection('c1', 'acord_126', { employee_count_full_time: 35 }, '2025-03-15T00:00:00Z')
    drafts.approve(d126.id, 'sarah', '2025-03-15T00:00:00Z')
    drafts.markFilled(d126.id, 'pdf/126', '2025-03-15T00:01:00Z') // 126 already filled
    // Now edit the shared field while approving 125.
    rc.approveForm('c1', 'acord_125', { edits: { employee_count_full_time: 40 }, by: 'sarah' })
    const cur126 = drafts.current('c1', 'acord_126')!
    expect(cur126.revision).toBe(2)                       // new revision created
    expect(cur126.status).toBe('needs_review')            // must be re-reviewed
    expect(drafts.byId(d126.id)!.status).toBe('filled')   // old 126 stays filled (immutable)
    expect(drafts.byId(d126.id)!.superseded_by_revision).toBe(2)
  })

  it('shared-field ripple cancels the OTHER form’s still-pending fill', () => {
    // 126 is approved with a fill still queued (not yet run by the worker).
    seedFact(facts, 'employee_count_full_time', 35)
    const d126 = drafts.upsertProjection('c1', 'acord_126', { employee_count_full_time: 35 }, '2025-03-15T00:00:00Z')
    drafts.approve(d126.id, 'sarah', '2025-03-15T00:00:00Z')
    const pending126 = outbox.enqueue('c1', 'acord_126', d126.revision, { employee_count_full_time: 35 }, 'h', '2025-03-15T00:00:00Z')
    // Now a shared field is edited while approving 125.
    rc.approveForm('c1', 'acord_125', { edits: { employee_count_full_time: 40 }, by: 'sarah' })
    // The stale 126 fill (targeting the now-superseded revision) is cancelled, not left to run.
    expect(outbox.get(pending126)!.status).toBe('cancelled')
    const cur126 = drafts.current('c1', 'acord_126')!
    expect(cur126.revision).toBe(2)
    expect(cur126.status).toBe('needs_review')
  })

  it('re-approving a filled form supersedes it onto a new revision', () => {
    const first = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    drafts.markFilled(first.draftId, 'pdf/x', '2025-03-16T00:00:00Z') // simulate worker filled it
    const second = rc.approveForm('c1', 'acord_125', { edits: { policyholder_first_name: 'Michael' }, by: 'sarah' })
    expect(second.revision).toBe(2)
    expect(drafts.byId(first.draftId)!.status).toBe('filled')  // old stays filled
    expect(drafts.byId(first.draftId)!.superseded_by_revision).toBe(2)
  })

  it('re-approving cancels a still-pending outbox row', () => {
    const first = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    const second = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    expect(outbox.get(first.outboxId)!.status).toBe('cancelled')
    expect(outbox.get(second.outboxId)!.status).toBe('pending')
  })

  it('lists and resolves conflicts', () => {
    conflicts.insert('c1', 'annual_gross_revenue', 'cur', 'confl', '2025-03-16T00:00:00Z')
    const open = rc.listUnresolvedConflicts('c1')
    expect(open).toHaveLength(1)
    rc.resolveConflict(open[0]!.id, 'sarah')
    expect(rc.listUnresolvedConflicts('c1')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/review/reviewClient.test.ts`
Expected: FAIL — cannot find `reviewClient.js`.

- [ ] **Step 3: Implement `src/review/reviewClient.ts`**

```ts
// src/review/reviewClient.ts
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { DraftsRepo } from '../db/repos/drafts.js'
import type { OutboxRepo } from '../db/repos/outbox.js'
import type { ConflictsRepo, ConflictRow } from '../db/repos/conflicts.js'
import type { FormType } from '../schema/profile.js'
import { renderForm, reverseResolve, toFillMapping } from '../forms/renderers.js'
import { STATIC_BINDINGS } from '../forms/bindings.js'
import { selectCurrentFact } from '../profile/factSelector.js'
import { contentHash } from '../util/hash.js'

export interface ReviewDeps {
  db: DB; facts: FactsRepo; drafts: DraftsRepo; outbox: OutboxRepo; conflicts: ConflictsRepo
  clock: Clock; formTypes: FormType[]; onEnqueued?: () => void
}
export interface ApproveOpts { edits?: Record<string, unknown>; by?: string }
export interface ApproveResult { draftId: string; revision: number; outboxId: string }

export class ReviewClient {
  constructor(private d: ReviewDeps) {}

  getDraft(customerId: string, formType: FormType) {
    const draft = this.d.drafts.current(customerId, formType)
    if (!draft) return undefined
    const mapping = JSON.parse(draft.projected_json) as Record<string, unknown>
    const bindings = this.d.drafts.getBindings(draft.id)
    const currentFacts = this.d.facts.currentMap(customerId)
    const fields = Object.keys(mapping).map(formFieldPath => {
      const profilePath = reverseResolve(formType, formFieldPath, bindings)
      const fact = profilePath ? currentFacts.get(profilePath) : undefined
      return {
        formFieldPath, value: mapping[formFieldPath],
        provenance: fact ? {
          quote: fact.evidence_quote,
          span: fact.evidence_span_start !== null ? [fact.evidence_span_start, fact.evidence_span_end] : null,
          confidence: fact.confidence, presence: fact.presence, review_status: fact.review_status,
          // the composite reviewers care about: a human signed off on leaving this blank
          approved_blank: fact.review_status === 'approved' && fact.presence !== 'present',
        } : null,
      }
    })
    return { draft, fields }
  }

  listUnresolvedConflicts(customerId: string): ConflictRow[] { return this.d.conflicts.listUnresolved(customerId) }
  resolveConflict(id: string, by: string): void { this.d.conflicts.resolve(id, by, this.d.clock.now()) }

  approveForm(customerId: string, formType: FormType, opts: ApproveOpts = {}): ApproveResult {
    const { facts, drafts, outbox, clock } = this.d
    const by = opts.by ?? 'reviewer'
    const now = clock.now()

    const tx = this.d.db.transaction((): ApproveResult => {
      const current = drafts.current(customerId, formType)
      if (!current) throw new Error(`no draft for ${customerId}/${formType}`)
      const bindings = drafts.getBindings(current.id)

      // 1. Resolve + apply edits (array paths via per-draft bindings, scalars via static).
      //    Edit lands on the CURRENT fact (selectCurrentFact), not an arbitrary row.
      const editedPaths: string[] = []
      for (const [formFieldPath, value] of Object.entries(opts.edits ?? {})) {
        const profilePath = reverseResolve(formType, formFieldPath, bindings)
        if (!profilePath) throw new Error(`unbound edit: ${formFieldPath}`)
        const cands = facts.byField(customerId, profilePath).filter(f => f.superseded_by === null)
        const target = selectCurrentFact(cands)
        if (!target) throw new Error(`no fact for ${profilePath}`)
        facts.markApproved(target.id, JSON.stringify(value), by, now)
        editedPaths.push(profilePath)
      }

      // 2. Approve EVERY form-bound current fact (not just edits).
      const currentFacts = facts.currentMap(customerId)
      for (const [path, fact] of currentFacts) {
        // only fields this form reads
        const reads = renderForm(formType, currentFacts).fieldBindings.some(b => b.profile_field_path === path)
        if (reads && fact.review_status !== 'approved') {
          facts.markApproved(fact.id, fact.reviewed_value_json ?? fact.value_json, by, now)
        }
      }

      // 3. Re-project from the just-approved state. `mapping` is FLAT (the human review surface
      //    + draft projection). `fillMapping` is the NESTED fill_form contract shape the PDF
      //    service consumes; the outbox carries it and content_hash is computed over it so the
      //    stored hash matches fillForm's content-addressed blob key.
      const fresh = facts.currentMap(customerId)
      const { mapping, fieldBindings } = renderForm(formType, fresh)
      const fillMapping = toFillMapping(mapping)
      const hash = contentHash({ customerId, formType, mapping: fillMapping })

      // 4. Supersede any outstanding fill; approve on the right revision. Drafts store the FLAT
      //    mapping (what the reviewer sees); only the outbox payload is nested.
      const pending = outbox.pendingForForm(customerId, formType)
      let draftRow = current
      if (pending || current.status === 'filled') {
        if (pending) outbox.cancel(pending.id)
        draftRow = drafts.newRevision(customerId, formType, mapping, now)
      } else {
        drafts.upsertProjection(customerId, formType, mapping, now)
        draftRow = drafts.current(customerId, formType)!
      }
      drafts.saveBindings(draftRow.id, fieldBindings)
      drafts.approve(draftRow.id, by, now)

      // 5. Enqueue the fill with the NESTED fill mapping (README fill_form shape).
      const outboxId = outbox.enqueue(customerId, formType, draftRow.revision, fillMapping, hash, now)

      // 6. Shared-field ripple: any OTHER form that reads an edited profile path and is
      //    already approved/filled gets a new needs_review revision (never mutated in place).
      if (editedPaths.length) {
        for (const other of this.d.formTypes) {
          if (other === formType) continue
          const reads = STATIC_BINDINGS[other].some(b => editedPaths.includes(b.profile_field_path))
          if (!reads) continue
          const otherDraft = drafts.current(customerId, other)
          if (!otherDraft || (otherDraft.status !== 'approved' && otherDraft.status !== 'filled')) continue
          // Cancel any in-flight fill for the other form FIRST: it targets the revision we are
          // about to supersede, so letting it run would fill stale, pre-edit data. The worker's
          // revision guard already refuses to markFilled a superseded draft, but cancelling
          // also avoids the wasted fillForm call and a dangling PDF.
          const otherPending = outbox.pendingForForm(customerId, other)
          if (otherPending) outbox.cancel(otherPending.id)
          const r = renderForm(other, fresh)
          const rev = drafts.newRevision(customerId, other, r.mapping, now)
          drafts.saveBindings(rev.id, r.fieldBindings)
          // left as needs_review — a shared change must be re-reviewed on the other form
        }
      }

      return { draftId: draftRow.id, revision: draftRow.revision, outboxId }
    })

    const result = tx()
    this.d.onEnqueued?.() // wake-on-commit, AFTER the txn commits
    return result
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/review/reviewClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review/reviewClient.ts tests/review/reviewClient.test.ts
git commit -m "feat: ReviewClient.approveForm (full-form approval, supersession, conflicts)"
```

---

## Task 14: Outbox worker (fill + fencing + backoff)

**Files:**
- Create: `src/worker/outboxWorker.ts`
- Test: `tests/worker/outboxWorker.test.ts`

**Interfaces:**
- Consumes: `DB`, `OutboxRepo`, `DraftsRepo`, `LeaseClaimer` (on `outbox`), `fillForm`, `BlobStore`, `Clock`.
- Produces: `class OutboxWorker { drainOnce(): Promise<number> }` — claims a batch, for each: `fillForm` → `drafts.markFilled` → `lease.complete(id, token)`; on error `lease.fail(...)` with exponential backoff. Fencing means a cancelled/reclaimed row's completion no-ops (and we skip `markFilled` when complete() returns false).

- [ ] **Step 1: Write the failing test**

```ts
// tests/worker/outboxWorker.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MemoryBlobStore } from '../../src/blob/blobStore.js'
import { OutboxWorker } from '../../src/worker/outboxWorker.js'
import { FixedClock } from '../../src/clock.js'

describe('OutboxWorker.drainOnce', () => {
  let db: DB, outbox: OutboxRepo, drafts: DraftsRepo, blob: MemoryBlobStore, worker: OutboxWorker
  const clock = new FixedClock('2025-03-16T00:00:00Z')
  beforeEach(() => {
    db = openDb(); migrate(db)
    outbox = new OutboxRepo(db); drafts = new DraftsRepo(db); blob = new MemoryBlobStore()
    worker = new OutboxWorker({ db, outbox, drafts, blob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'w1' })
  })

  it('fills a pending row and marks the draft filled', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const n = await worker.drainOnce()
    expect(n).toBe(1)
    expect(outbox.get(oid)!.status).toBe('done')
    expect(drafts.byId(d.id)!.status).toBe('filled')
    expect(drafts.byId(d.id)!.pdf_ref).toBeTruthy()
  })

  it('a cancelled row does not get filled (fencing)', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    outbox.cancel(oid) // superseded before the worker runs
    const n = await worker.drainOnce()
    expect(n).toBe(0)
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })

  it('completion+fill are atomic: if markFilled throws, outbox does NOT become done', async () => {
    const d = drafts.upsertProjection('c1', 'acord_125', { fein: 'A' }, '2025-03-15T00:00:00Z')
    drafts.approve(d.id, 'sarah', '2025-03-16T00:00:00Z')
    const oid = outbox.enqueue('c1', 'acord_125', d.revision, { fein: 'A' }, 'hash', '2025-03-16T00:00:00Z')
    const orig = drafts.markFilled.bind(drafts)
    ;(drafts as any).markFilled = () => { throw new Error('crash after complete()') }
    const n = await worker.drainOnce()
    ;(drafts as any).markFilled = orig
    expect(n).toBe(0)
    // The txn rolled back: the row is NOT 'done' and NOT stranded — it stays claimable.
    expect(outbox.get(oid)!.status).not.toBe('done')
    expect(drafts.byId(d.id)!.status).not.toBe('filled')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/worker/outboxWorker.test.ts`
Expected: FAIL — cannot find `outboxWorker.js`.

- [ ] **Step 3: Implement `src/worker/outboxWorker.ts`**

```ts
// src/worker/outboxWorker.ts
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { OutboxRepo } from '../db/repos/outbox.js'
import type { DraftsRepo } from '../db/repos/drafts.js'
import type { LeaseClaimer } from '../lease/leaseClaimer.js'
import type { BlobStore } from '../blob/blobStore.js'
import type { FormType } from '../schema/profile.js'
import type { FillMapping } from '../schema/forms.js'
import { fillForm } from '../forms/fillForm.js'

export interface OutboxWorkerDeps {
  db: DB; outbox: OutboxRepo; drafts: DraftsRepo; blob: BlobStore; lease: LeaseClaimer
  clock: Clock; workerId: string; leaseMs?: number; batch?: number; maxAttempts?: number
}
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

export class OutboxWorker {
  constructor(private d: OutboxWorkerDeps) {}

  async drainOnce(): Promise<number> {
    const now = this.d.clock.now()
    const claimed = this.d.lease.claim(now, this.d.leaseMs ?? 30_000, this.d.workerId, this.d.batch ?? 10)
    let filled = 0
    for (const { id, lock_token } of claimed) {
      const row = this.d.outbox.get(id)
      if (!row || row.status !== 'processing') continue
      try {
        // payload_json is the NESTED fill mapping (README fill_form shape), enqueued at approve time.
        const mapping = JSON.parse(row.payload_json) as FillMapping
        // External I/O (PDF generation) happens OUTSIDE any DB transaction.
        const { pdf_ref } = await fillForm(row.customer_id, row.form_type as FormType, mapping, this.d.blob)
        // Commit `outbox=done` AND `draft=filled` atomically. If the process dies between
        // them, neither lands: the row is still 'processing', its lease expires, and it is
        // re-fetched — never stranded as a done outbox row over an unfilled draft.
        // `complete()` is fenced (id+token+status='processing'); if we lost the lease it
        // returns false and we throw to roll the whole transaction back (no markFilled).
        const commit = this.d.db.transaction(() => {
          if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
          const draft = this.d.drafts.current(row.customer_id, row.form_type as FormType)
          if (draft && draft.revision === row.draft_revision) this.d.drafts.markFilled(draft.id, pdf_ref, this.d.clock.now())
        })
        try {
          commit(); filled++
        } catch {
          // Rolled back (lost lease, or a local write failed). fail() is fenced: a no-op if
          // we no longer hold the lease, otherwise it applies backoff + dead-letters at max.
          // fillForm is idempotent on customer+form+revision, so a retry is safe.
          this.fail(id, lock_token, row.attempts, now)
        }
      } catch {
        this.fail(id, lock_token, row.attempts, now)
      }
    }
    return filled
  }

  private fail(id: string, lockToken: string, attempts: number, now: string): void {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!
    const next = new Date(new Date(now).getTime() + backoff).toISOString()
    this.d.lease.fail(id, lockToken, next, this.d.maxAttempts ?? 5)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/worker/outboxWorker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker/outboxWorker.ts tests/worker/outboxWorker.test.ts
git commit -m "feat: outbox worker with fenced fill + backoff"
```

---

## Task 15: Sources/Jobs repos + Processor (durable ingest)

**Files:**
- Create: `src/db/repos/sources.ts`, `src/db/repos/jobs.ts`, `src/worker/processor.ts`
- Test: `tests/worker/processor.test.ts`

**Interfaces:**
- Consumes: `DB`, `LlmClient`, `extractFacts`, `reconcile`, `FactsRepo`, `ConflictsRepo`, `CollectionItemsRepo`, `DraftsRepo`, `renderForm`, `LeaseClaimer` (on `processing_jobs`), `Clock`.
- Produces:
  - `class SourcesRepo { insert(row): void; get(id): SourceRow | undefined }`.
  - `class ProcessingJobsRepo { get(id): JobRow | undefined }` (claim/complete/fail via `LeaseClaimer`).
  - `insertSourceAndJob(db, {source, job})` — single-txn durable enqueue helper.
  - `class Processor { drainOnce(): Promise<number> }` — claims a job, loads its source, `llm.extract` → `extractFacts` → `facts.insertMany` → `reconcile` → re-project each form draft (`upsertProjection`), completes the job.

- [ ] **Step 1: Write the failing test**

```ts
// tests/worker/processor.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import fixture from '../fixtures/llm/coastal_v1.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { SourcesRepo, insertSourceAndJob } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MockLlmClient } from '../../src/extraction/llmClient.js'
import { Processor } from '../../src/worker/processor.js'
import { FixedClock } from '../../src/clock.js'
import { newId } from '../../src/util/id.js'

describe('Processor.drainOnce', () => {
  let db: DB
  const clock = new FixedClock('2025-03-12T10:30:00Z')
  beforeEach(() => { db = openDb(); migrate(db) })

  function makeProcessor() {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db),
      facts: new FactsRepo(db), conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db),
      drafts: new DraftsRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'),
      llm: new MockLlmClient(fixture), clock, workerId: 'w1', formTypes: ['acord_125'],
    })
  }

  it('processes a durably-enqueued source into facts + a projected draft', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'about $30,000; roughly 35 full-time guys' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const n = await makeProcessor().drainOnce()
    expect(n).toBe(1)
    const rev = new FactsRepo(db).byField('c1', 'annual_gross_revenue')
    expect(rev.length).toBeGreaterThan(0)
    const draft = new DraftsRepo(db).current('c1', 'acord_125')
    expect(draft).toBeTruthy()
    expect(JSON.parse(draft!.projected_json).annual_gross_revenue).toBe(2500000)
  })

  it('marks the job done so a second drain does nothing', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'x' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    await makeProcessor().drainOnce()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).toBe('done')
    expect(await makeProcessor().drainOnce()).toBe(0)
  })

  it('persistence + job completion are atomic: a lost lease at commit rolls back ALL persistence', async () => {
    const sourceId = newId(), jobId = newId()
    insertSourceAndJob(db, {
      source: { id: sourceId, customer_id: 'c1', type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
        received_at: '2025-03-12T10:31:00Z', raw_json: JSON.stringify({ content: 'about $30,000; roughly 35 full-time guys' }), checksum: 'x' },
      job: { id: jobId, source_id: sourceId, customer_id: 'c1', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
    })
    const proc = makeProcessor()
    // Simulate losing the lease exactly at commit (another worker reclaimed after our lease expired).
    ;((proc as any).d.lease as LeaseClaimer).complete = () => false
    const n = await proc.drainOnce()
    expect(n).toBe(0)
    // Because completion is INSIDE the persist transaction, its failure rolls everything back:
    // no facts, no draft, and the job is NOT marked done (it stays reclaimable).
    expect(new FactsRepo(db).byField('c1', 'annual_gross_revenue').length).toBe(0)
    expect(new DraftsRepo(db).current('c1', 'acord_125')).toBeFalsy()
    expect(new ProcessingJobsRepo(db).get(jobId)!.status).not.toBe('done')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/worker/processor.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement `src/db/repos/sources.ts`**

```ts
// src/db/repos/sources.ts
import type { DB } from '../sqlite.js'

export interface SourceRow {
  id: string; customer_id: string; type: string; source_date: string; received_at: string
  raw_json: string; checksum: string; status?: string
}
export interface JobInsert {
  id: string; source_id: string; customer_id: string; next_attempt_at: string; created_at: string
}

export class SourcesRepo {
  constructor(private db: DB) {}
  get(id: string): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined
  }
  existsById(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(id)
  }
  existsByChecksum(checksum: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sources WHERE checksum=?').get(checksum)
  }
}

/** Durable ingest: source + processing job committed atomically. */
export function insertSourceAndJob(db: DB, args: { source: SourceRow; job: JobInsert }): void {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO sources (id,customer_id,type,source_date,received_at,raw_json,checksum,status)
      VALUES (@id,@customer_id,@type,@source_date,@received_at,@raw_json,@checksum,'received')`).run(args.source)
    db.prepare(`INSERT INTO processing_jobs (id,source_id,customer_id,status,attempts,next_attempt_at,created_at)
      VALUES (@id,@source_id,@customer_id,'pending',0,@next_attempt_at,@created_at)`).run(args.job)
  })
  tx()
}
```

- [ ] **Step 4: Implement `src/db/repos/jobs.ts`**

```ts
// src/db/repos/jobs.ts
import type { DB } from '../sqlite.js'

export interface JobRow {
  id: string; source_id: string; customer_id: string; status: string; attempts: number
  next_attempt_at: string; locked_until: string | null; lock_token: string | null; locked_by: string | null; created_at: string
}
export class ProcessingJobsRepo {
  constructor(private db: DB) {}
  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(id) as JobRow | undefined
  }
}
```

- [ ] **Step 5: Implement `src/worker/processor.ts`**

```ts
// src/worker/processor.ts
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { SourcesRepo } from '../db/repos/sources.js'
import type { ProcessingJobsRepo } from '../db/repos/jobs.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { ConflictsRepo } from '../db/repos/conflicts.js'
import type { CollectionItemsRepo } from '../db/repos/collectionItems.js'
import type { DraftsRepo } from '../db/repos/drafts.js'
import type { LeaseClaimer } from '../lease/leaseClaimer.js'
import type { LlmClient } from '../extraction/llmClient.js'
import type { FormType } from '../schema/profile.js'
import { extractFacts } from '../extraction/extractor.js'
import { reconcile } from '../profile/reconciler.js'
import { renderForm } from '../forms/renderers.js'

export interface ProcessorDeps {
  db: DB; sources: SourcesRepo; jobs: ProcessingJobsRepo; facts: FactsRepo; conflicts: ConflictsRepo
  items: CollectionItemsRepo; drafts: DraftsRepo; lease: LeaseClaimer; llm: LlmClient
  clock: Clock; workerId: string; formTypes: FormType[]; leaseMs?: number; batch?: number; maxAttempts?: number
}
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

export class Processor {
  constructor(private d: ProcessorDeps) {}

  async drainOnce(): Promise<number> {
    const now = this.d.clock.now()
    const claimed = this.d.lease.claim(now, this.d.leaseMs ?? 60_000, this.d.workerId, this.d.batch ?? 5)
    let done = 0
    for (const { id, lock_token } of claimed) {
      const job = this.d.jobs.get(id)
      if (!job || job.status !== 'processing') continue
      try {
        const source = this.d.sources.get(job.source_id)
        if (!source) { this.d.lease.complete(id, lock_token); continue }
        const transcript = JSON.parse(source.raw_json).content as string

        const env = await this.d.llm.extract(transcript) // async: OUTSIDE any txn
        const facts = extractFacts(env, {
          customerId: job.customer_id, sourceId: source.id, sourceDate: source.source_date,
          transcript, clock: this.d.clock, itemsRepo: this.d.items,
        })

        // Persistence AND job completion commit together in one transaction. If the process
        // dies before commit, nothing lands and the job (still 'processing') is reclaimed and
        // redone cleanly. If it commits, the job is 'done' in the SAME commit — so a reclaim can
        // never re-run upsertProjection over a draft a human approved in the meantime. The
        // async llm.extract already ran ABOVE, outside any transaction.
        const persistAndComplete = this.d.db.transaction(() => {
          this.d.facts.insertMany(facts)
          reconcile({ db: this.d.db, facts: this.d.facts, conflicts: this.d.conflicts, clock: this.d.clock, customerId: job.customer_id, formTypes: this.d.formTypes })
          const currentFacts = this.d.facts.currentMap(job.customer_id)
          for (const ft of this.d.formTypes) {
            const { mapping, fieldBindings } = renderForm(ft, currentFacts)
            const draft = this.d.drafts.upsertProjection(job.customer_id, ft, mapping, this.d.clock.now())
            this.d.drafts.saveBindings(draft.id, fieldBindings)
          }
          // Fenced: false if we lost the lease. Throw to roll the whole persistence back so
          // another worker's run is the single source of truth — never double-applied.
          if (!this.d.lease.complete(id, lock_token)) throw new Error('lost lease')
        })
        // On commit failure (lost lease OR a real persistence error) back off. fail() is
        // fenced, so a lost-lease rollback is a harmless no-op; a real error gets retried.
        try { persistAndComplete(); done++ } catch { this.fail(id, lock_token, job.attempts, now) }
      } catch {
        this.fail(id, lock_token, job.attempts, now)
      }
    }
    return done
  }

  private fail(id: string, lockToken: string, attempts: number, now: string): void {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!
    const next = new Date(new Date(now).getTime() + backoff).toISOString()
    this.d.lease.fail(id, lockToken, next, this.d.maxAttempts ?? 5)
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/worker/processor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/sources.ts src/db/repos/jobs.ts src/worker/processor.ts tests/worker/processor.test.ts
git commit -m "feat: durable ingest processor (extract+reconcile+project)"
```

---

## Task 16: Webhook + server wiring

**Files:**
- Create: `src/ingest/webhook.ts`, `src/server.ts`
- Test: `tests/ingest/webhook.test.ts`

**Interfaces:**
- Consumes: Fastify, `insertSourceAndJob`, `SourcesRepo` (dedupe by `source.id` or checksum), `contentHash`, `newId`, `Clock`, and a `wake()` callback for the processor.
- Produces: `buildWebhookApp(deps): FastifyInstance` with `POST /webhook/transcript` accepting `{ customer_id, source: { id, type, date, content } }`; persists source+job in one txn, returns `202 { job_id }`; deduplicates a re-delivered source by checksum (returns `200 { deduped: true }`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ingest/webhook.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { buildWebhookApp } from '../../src/ingest/webhook.js'
import { FixedClock } from '../../src/clock.js'

const body = {
  customer_id: 'c1',
  source: { id: 'src_001', type: 'call_transcript', date: '2025-03-12T10:30:00Z', content: 'hello' },
}

describe('POST /webhook/transcript', () => {
  let db: DB, app: ReturnType<typeof buildWebhookApp>
  beforeEach(async () => {
    db = openDb(); migrate(db)
    app = buildWebhookApp({ db, clock: new FixedClock('2025-03-12T10:31:00Z'), wake: () => {} })
  })

  it('persists source + job and returns 202', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    expect(res.statusCode).toBe(202)
    expect(db.prepare('SELECT COUNT(*) n FROM sources').get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM processing_jobs').get()).toMatchObject({ n: 1 })
  })

  it('dedupes a re-delivered identical source', async () => {
    await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    const res2 = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: body })
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body).deduped).toBe(true)
    expect(db.prepare('SELECT COUNT(*) n FROM sources').get()).toMatchObject({ n: 1 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ingest/webhook.test.ts`
Expected: FAIL — cannot find `webhook.js`.

- [ ] **Step 3: Implement `src/ingest/webhook.ts`**

```ts
// src/ingest/webhook.ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import { SourcesRepo, insertSourceAndJob } from '../db/repos/sources.js'
import { contentHash } from '../util/hash.js'
import { newId } from '../util/id.js'

export interface WebhookDeps { db: DB; clock: Clock; wake: () => void }

export function buildWebhookApp(deps: WebhookDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const sources = new SourcesRepo(deps.db)

  app.post('/webhook/transcript', async (req, reply) => {
    const b = req.body as { customer_id: string; source: { id: string; type: string; date: string; content: string } }
    if (!b?.customer_id || !b?.source?.content) return reply.code(400).send({ error: 'bad payload' })

    // Idempotent ingest: a re-delivered source.id is a duplicate regardless of content
    // (a genuine correction arrives as a NEW source with its own id). Checksum catches an
    // id-less exact re-delivery. Either way we never PK-collide.
    const checksum = contentHash({ customer_id: b.customer_id, id: b.source.id, content: b.source.content })
    if (sources.existsById(b.source.id) || sources.existsByChecksum(checksum)) {
      return reply.code(200).send({ deduped: true })
    }

    const now = deps.clock.now()
    const jobId = newId()
    insertSourceAndJob(deps.db, {
      source: { id: b.source.id, customer_id: b.customer_id, type: b.source.type, source_date: b.source.date,
        received_at: now, raw_json: JSON.stringify({ content: b.source.content }), checksum },
      job: { id: jobId, source_id: b.source.id, customer_id: b.customer_id, next_attempt_at: now, created_at: now },
    })
    deps.wake() // nudge the processor (best-effort; polling backstop covers misses)
    return reply.code(202).send({ job_id: jobId })
  })

  return app
}
```

- [ ] **Step 4: Implement `src/server.ts`**

```ts
// src/server.ts
import { openDb, migrate } from './db/sqlite.js'
import { SystemClock } from './clock.js'
import { buildWebhookApp } from './ingest/webhook.js'
import { SourcesRepo } from './db/repos/sources.js'
import { ProcessingJobsRepo } from './db/repos/jobs.js'
import { FactsRepo } from './db/repos/facts.js'
import { ConflictsRepo } from './db/repos/conflicts.js'
import { CollectionItemsRepo } from './db/repos/collectionItems.js'
import { DraftsRepo } from './db/repos/drafts.js'
import { OutboxRepo } from './db/repos/outbox.js'
import { LeaseClaimer } from './lease/leaseClaimer.js'
import { MemoryBlobStore } from './blob/blobStore.js'
import { AiSdkLlmClient, MockLlmClient } from './extraction/llmClient.js'
import { Processor } from './worker/processor.js'
import { OutboxWorker } from './worker/outboxWorker.js'
import { ReviewClient } from './review/reviewClient.js'
import type { FormType } from './schema/profile.js'

const clock = new SystemClock()
const db = openDb(process.env.DB_PATH ?? 'data/acord.db')
migrate(db)

const formTypes: FormType[] = ['acord_125', 'acord_126']
const blob = new MemoryBlobStore()
const llm = process.env.LLM_LIVE === '1' ? new AiSdkLlmClient() : new MockLlmClient({})

const processor = new Processor({
  db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
  conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
  lease: new LeaseClaimer(db, 'processing_jobs'), llm, clock, workerId: 'proc-1', formTypes,
})
const outboxWorker = new OutboxWorker({
  db, outbox: new OutboxRepo(db), drafts: new DraftsRepo(db), blob,
  lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'fill-1',
})

// The human-review surface. onEnqueued is the spec's PRIMARY wake-on-commit path:
// an approval nudges the fill worker immediately (the poll below is only the backstop).
export const reviewClient = new ReviewClient({
  db, facts: new FactsRepo(db), drafts: new DraftsRepo(db), outbox: new OutboxRepo(db),
  conflicts: new ConflictsRepo(db), clock, formTypes,
  onEnqueued: () => { void outboxWorker.drainOnce() },
})

// Adaptive backstop poll (wake-on-commit calls drainOnce directly elsewhere).
let idle = 1000
async function loop(run: () => Promise<number>, min = 1000, max = 30_000) {
  const n = await run()
  idle = n > 0 ? min : Math.min(idle * 2, max)
  setTimeout(() => loop(run, min, max), idle)
}
loop(() => processor.drainOnce())
loop(() => outboxWorker.drainOnce())

const app = buildWebhookApp({ db, clock, wake: () => { void processor.drainOnce() } })
app.listen({ port: Number(process.env.PORT ?? 8080) }).then(() => console.log('webhook up'))
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/ingest/webhook.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/webhook.ts src/server.ts tests/ingest/webhook.test.ts
git commit -m "feat: webhook (durable ingest) + server wiring"
```

---

## Task 17: End-to-end integration + correction fixture

**Files:**
- Create: `tests/fixtures/transcripts.json` (copied from repo root), `tests/fixtures/llm/coastal_v2.json` (correction), `tests/integration/pipeline.test.ts`

**Interfaces:**
- Consumes: everything. A `RoutingLlmClient` test helper that returns a different canned envelope per `source_id` (so the two transcripts extract differently).

- [ ] **Step 1: Create the correction fixture `tests/fixtures/llm/coastal_v2.json`**

```json
{
  "annual_gross_revenue": { "value": 2800000, "presence": "present", "confidence": 0.9, "evidence": "revenue was actually 2.8 million" },
  "annual_payroll": { "value": 1750000, "presence": "present", "confidence": 0.9, "evidence": "payroll was 1,750,000" }
}
```

- [ ] **Step 2: Write the end-to-end test**

```ts
// tests/integration/pipeline.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import v1 from '../fixtures/llm/coastal_v1.json'
import v2 from '../fixtures/llm/coastal_v2.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { buildWebhookApp } from '../../src/ingest/webhook.js'
import { SourcesRepo } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MemoryBlobStore } from '../../src/blob/blobStore.js'
import { Processor } from '../../src/worker/processor.js'
import { OutboxWorker } from '../../src/worker/outboxWorker.js'
import { ReviewClient } from '../../src/review/reviewClient.js'
import { FixedClock } from '../../src/clock.js'
import type { LlmClient } from '../../src/extraction/llmClient.js'
import { ExtractionEnvelope } from '../../src/schema/profile.js'

// Returns a different envelope per call so the two transcripts differ.
class RoutingLlm implements LlmClient {
  private i = 0
  constructor(private envs: unknown[]) {}
  async extract() { return ExtractionEnvelope.parse(this.envs[this.i++] ?? {}) }
}

describe('end-to-end pipeline', () => {
  let db: DB
  const clock = new FixedClock('2025-03-12T10:31:00Z')
  const formTypes = ['acord_125'] as const
  beforeEach(() => { db = openDb(); migrate(db) })

  function processor(llm: LlmClient) {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
      conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
      lease: new LeaseClaimer(db, 'processing_jobs'), llm, clock, workerId: 'w', formTypes: [...formTypes],
    })
  }

  it('ingest -> extract -> review -> approve -> fill, then a correction raises a conflict', async () => {
    const app = buildWebhookApp({ db, clock, wake: () => {} })
    const llm = new RoutingLlm([v1, v2])

    // 1. First transcript in.
    await app.inject({ method: 'POST', url: '/webhook/transcript', payload: {
      customer_id: 'c1', source: { id: 'src_001', type: 'call_transcript', date: '2025-03-12T10:30:00Z', content: 'about two and a half million' } } })
    expect(await processor(llm).drainOnce()).toBe(1)

    const facts = new FactsRepo(db), drafts = new DraftsRepo(db), outbox = new OutboxRepo(db), conflicts = new ConflictsRepo(db)
    const blob = new MemoryBlobStore()
    const rc = new ReviewClient({ db, facts, drafts, outbox, conflicts, clock, formTypes: [...formTypes], onEnqueued: () => {} })

    // 2. Human approves the form (revenue currently 2.5M).
    const approved = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    expect(facts.byField('c1', 'annual_gross_revenue').some(f => f.review_status === 'approved')).toBe(true)

    // 3. Outbox worker fills the PDF.
    const worker = new OutboxWorker({ db, outbox, drafts, blob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'f' })
    expect(await worker.drainOnce()).toBe(1)
    expect(drafts.byId(approved.draftId)!.status).toBe('filled')
    expect(await blob.get(drafts.byId(approved.draftId)!.pdf_ref!)).not.toBeNull()

    // 4. Correction transcript arrives (2.8M) -> conflict surfaced, approved value stays current.
    clock.set('2025-03-16T09:00:00Z')
    await app.inject({ method: 'POST', url: '/webhook/transcript', payload: {
      customer_id: 'c1', source: { id: 'src_002', type: 'call_transcript', date: '2025-03-15T10:00:00Z', content: 'revenue was actually 2.8 million' } } })
    expect(await processor(llm).drainOnce()).toBe(1)

    const open = rc.listUnresolvedConflicts('c1')
    expect(open.some(c => c.field_path === 'annual_gross_revenue')).toBe(true)
  })
})
```

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `npx vitest run tests/integration/pipeline.test.ts`
Expected: initially FAIL if any wiring gap; fix wiring until PASS (1 test).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add tests/integration tests/fixtures
git commit -m "test: end-to-end pipeline incl. correction/conflict path"
```

---

## Self-Review

**Spec coverage:**
- Canonical profile + projections → Tasks 2, 7. ✅
- Fact shape (value+presence+evidence+confidence+match_quality) → Task 2. ✅
- Presence states incl. needs_follow_up → Task 2 (fixture exercises it), Task 9. ✅
- `selectCurrentFact` rule → Task 5. ✅
- Collection identity (stable idempotent item_id + registry) → Tasks 1, 6, 9. ✅
- Per-draft array bindings → Tasks 7, 12 (saveBindings), 13 (reverse-resolve). ✅
- Durable ingest (source+job one txn) → Tasks 3, 15, 16. ✅
- Extraction contract (LlmClient, Output.object, bounded retry, evidence spans) → Tasks 8, 9. ✅
- Reconciler (materialize missing, conflicts) → Task 10. ✅
- Visible conflicts read model → Tasks 10, 13. ✅
- Approve = one short txn, full-form approval, supersede pending/processing/filled → Task 13. ✅
- Outbox + wake-on-commit + fencing + backoff → Tasks 4, 13 (onEnqueued), 14. ✅
- Lease recovery + token+status fencing → Task 4, exercised in 14. ✅
- `fillForm` deterministic blob key → Task 11. ✅
- Immutable filled drafts / revisions / superseded_by_revision → Tasks 12, 13. ✅
- Webhook 202 + dedupe → Task 16. ✅
- Out-of-order/correction multi-transcript → Task 17. ✅

**Gaps intentionally deferred (noted, not built):** see the "Explicit Scope / Deferrals"
section at the top — 126-specific fields and five repeated collections are not wired
(mechanical to add). The **cross-form shared-field ripple IS implemented and tested**
(Task 13, step 6 + the ripple test) via the shared `employee_count_*` bindings — this was a
review finding that has been fixed.

### Post-review fixes applied (independent audit)

An independent reviewer audited this plan against the spec; all findings were verified and
resolved here:

- **#1 (HIGH)** — `renderForm` now uses `effectiveValueJson` (`reviewed_value_json ?? value_json`), so human edits reach the projected draft **and** the outbox payload; asserted in Task 13.
- **#2 (HIGH)** — cross-form shared-field ripple implemented in `approveForm` step 6 (+ test).
- **#3 (HIGH)** — extractor flattens fixed nested objects (`mailing_address.*`) into leaf facts matching the bindings (+ test).
- **#5 (MED)** — deterministic `factIdFor` + `INSERT OR IGNORE` makes reprocessing idempotent (+ test).
- **#6 (MED)** — edits target `selectCurrentFact`, not `cands[0]`.
- **#9/#10/#11/#12/#13/#14 (LOW)** — removed the tautological review-status branch; implemented `FactsRepo.supersede`; wired `ReviewClient` + wake-on-commit in `server.ts`; surfaced `approved_blank` in `getDraft`; normalized-match returns a `null` span (not `[0,0]`); webhook dedupes by `source.id`.
- **#7 (spec)** — the spec's "changed natural key auto-resolves via registry" overclaim was removed; a changed key now correctly yields a new item surfaced for human merge.
- **Not built (documented):** reviewer-set `not_applicable` action (#12 setter) — `approved_blank` is surfaced read-side; the setter is a small extension listed under Deferrals.

**Second review round (production-hardening) — all resolved:**

- **AI SDK deps** — `package.json` pins `ai@^6` / `@ai-sdk/openai@^3` (the v6 line whose stable API is `generateText({ output: Output.object }) `); `generateObject` explicitly banned. Global Constraints note the provider-major/peer-dep rule.
- **Outbox atomicity** — `outbox → done` and `draft → filled` now commit in **one fenced transaction** (`complete()` inside the txn, throw-to-rollback on lost lease); a crash between them can no longer strand a draft as `approved` forever. Test added.
- **Lease claim atomicity** — `claim()` uses `BEGIN IMMEDIATE` + a **guarded per-row UPDATE** (re-checks the claimable predicate) and returns only rows whose update won, so two workers can never lease the same row.
- **Processor idempotency** — fact/draft persistence **and** job completion commit in one transaction; a post-crash reclaim can no longer re-run `upsertProjection` and reset an approved draft. Rollback test added.
- **Ripple cancels stale fill** — the shared-field ripple now `cancel`s the OTHER form's pending/processing outbox row before minting its new revision (+ the requested "approved 126 with pending fill, then 125 edits shared field" test).
- **`upsertProjection` over a filled draft** now routes through `newRevision()`, always setting `superseded_by_revision` on the old row (no dangling current row). Test added.
- **`not_applicable`** — honestly scoped: `approved_blank` sign-off is built and tested; reviewer-initiated present→N/A is documented in Explicit Scope / Deferrals, not half-implemented.
- **`FormMapping`** widened to a recursive `JsonValue` so it can represent the real `fill_form` contract (nested `mailing_address`, `prior_carriers[]`), not just scalars.

**Third review round — flat review mapping vs nested fill mapping:**

- **Two projections, one source.** `renderForm` still emits the FLAT mapping (dotted/bracketed keys) that drives the review UI, edit resolution, draft `projected_json`, and field bindings — a flat, per-field surface is what a human reviewer (and reverse-edit resolution) needs. A new pure `toFillMapping` unflattens it into the NESTED `fill_form` contract shape (README: `mailing_address: {…}`, `claims: […]`), which is what the outbox payload carries and `fillForm` consumes. Human-facing mapping ≠ machine-facing mapping; both derive deterministically from the same facts. `FillMapping` alias added (structurally identical to `FormMapping`, documents intent). `content_hash` is now computed over the nested fill mapping so the stored hash matches `fillForm`'s content-addressed blob key. Tests added: `toFillMapping` (objects + arrays) and `fillForm` round-trips the nested shape verbatim.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The one explicit "both arms equal" branch in Task 9 is documented as intentional, not a placeholder.

**Type consistency:** `selectCurrentFact`, `renderForm`/`reverseResolve`/`boundScalarPaths`/`toFillMapping`, `LeaseClaimer.{claim,complete,fail}`, `FactsRepo.{insertMany,byField,currentMap,markApproved,allFieldPaths}`, `DraftsRepo.{upsertProjection,newRevision,saveBindings,getBindings,approve,markFilled,supersede,byId,current}`, `OutboxRepo.{enqueue,pendingForForm,cancel,get}`, `ReviewClient.{getDraft,approveForm,listUnresolvedConflicts,resolveConflict}` — names used identically across all consuming tasks. ✅
