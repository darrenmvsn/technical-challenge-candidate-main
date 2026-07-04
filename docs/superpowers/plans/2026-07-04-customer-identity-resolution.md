# Customer Identity Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept the actual raw transcript webhook payload and resolve it to a stable customer before any customer-scoped facts, drafts, conflicts, or outbox rows are written.

**Architecture:** Raw transcript ingest is durable and customer-agnostic. The processor extracts an envelope, validates identity evidence against the transcript, resolves identity from exact hard identifiers, then attaches the source to a customer and only then persists canonical field candidates. Ambiguous, weak, fuzzy, or unverified identity matches stop in a review state instead of silently merging customers.

**Tech Stack:** TypeScript ESM, strict TS, Fastify, Zod, better-sqlite3, Vitest.

---

## Design Shift

The existing implementation assumes the webhook body contains `customer_id`. The actual
`transcripts.json` fixture does not. Therefore:

- `sources` must be able to exist before customer identity is known.
- `processing_jobs` must claim raw source jobs without needing `customer_id`.
- Identity resolution happens after LLM extraction and before customer-scoped persistence.
- Identity auto-resolution is exact-match only after normalization. No fuzzy business-name,
  partial-address, or "close enough" matching may attach two sources to the same customer.
- `facts` / `extracted_field_candidates`, `collection_items`, `form_drafts`, `outbox`, and conflicts remain customer-scoped.
- No field candidate is inserted until a source has a resolved `customer_id`.

This plan should be implemented before the field-review-version refactor, or folded into it
as Task 0. Do not keep accepting `customer_id` at the webhook boundary for this challenge.

### Delivery contract (confirmed 2026-07-04)

Upstream delivers **exactly one transcript object per webhook POST**. `transcripts.json` is a
single-element sample array wrapping that one object; the webhook validates a single object and
does **not** need to accept a top-level array. (Tests may unwrap `transcriptFixture[0]` to obtain
the object.)

### Self-heal tradeoff (review 2026-07-04) — READ BEFORE EXECUTING

The product north star includes "*a later correcting transcript self-heals*", which requires
transcript 2 to resolve to the **same** customer as transcript 1. Auto-resolution here is
exact-hard-signal-only (see Resolution Rules), so a correction call that does **not** restate a
hard identifier (FEIN/email) will land in `identity_needs_review` rather than self-healing
automatically. This is a deliberate safety stance — never silently merge — but it has a concrete
consequence:

- The end-to-end correction fixture (ACORD-703 / `tests/integration/pipeline.test.ts`) **must**
  carry a hard identifier (FEIN or email) in the correcting transcript, or the automatic
  self-heal path it asserts will instead stop at identity review. Verify this in Task 7 Step 3.
- Corrections lacking a hard identifier are expected to require a one-click human attach via the
  `IdentityReviewClient` (Task 6). That is by design, not a bug.

---

## File Structure

Modify:

- `src/schema/profile.ts`
  - Add identity fields used for matching: `business_name`, `business_phone`, `policyholder_email`.
- `src/db/migrations.ts`
  - Make `sources.customer_id` nullable.
  - Remove `processing_jobs.customer_id` or make it nullable.
  - Add identity-resolution state tables.
- `src/db/repos/sources.ts`
  - Insert raw sources without customer ID.
  - Add `attachCustomer(sourceId, customerId, now)` and `saveExtraction(sourceId, envelopeJson)`.
- `src/db/repos/jobs.ts`
  - Update `JobRow` / `JobInsert` so jobs are source-scoped, not customer-scoped.
- `src/ingest/webhook.ts`
  - Accept the raw transcript payload shape from `transcripts.json`.
- `src/worker/processor.ts`
  - Resolve customer identity before calling `extractFacts`.
- `src/server.ts`
  - Wire identity repos into `Processor`.

Create:

- `src/identity/identitySignals.ts`
  - Build normalized identity signals from an `ExtractionEnvelope`.
- `src/db/repos/customerIdentity.ts`
  - Persist and query customer identity signals.
- `src/identity/customerResolver.ts`
  - Resolve extracted signals to one customer, create a new customer, or return `needs_review`.
- `src/review/identityReviewClient.ts`
  - Manually attach an ambiguous source to a customer and enqueue/retry processing.
- `tests/identity/customerResolver.test.ts`
- `tests/ingest/webhookRawTranscript.test.ts`
- `tests/worker/processorIdentity.test.ts`

---

## Target Data Model

Update `sources` so raw transcripts can land before identity is known:

```sql
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  type TEXT NOT NULL,
  source_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  extraction_json TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','resolved','identity_needs_review','dead'))
);
```

Update `processing_jobs` so jobs are source-scoped:

```sql
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  lock_token TEXT,
  locked_by TEXT,
  created_at TEXT NOT NULL
);
```

Add normalized identity signals:

```sql
CREATE TABLE IF NOT EXISTS customer_identity_signals (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('fein','email','phone','business_name_state','mailing_address')),
  signal_value TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(customer_id, signal_type, signal_value)
);
CREATE INDEX IF NOT EXISTS idx_customer_identity_lookup
  ON customer_identity_signals(signal_type, signal_value);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_identity_hard_unique
  ON customer_identity_signals(signal_type, signal_value)
  WHERE signal_type IN ('fein','email');
```

The lookup index covers both hard and supporting signals. Supporting signals must be searchable
so they can block unsafe auto-create / auto-merge decisions, but they never resolve a source by
themselves. The partial unique index is only for hard identifiers: the same FEIN or business email
cannot belong to two different customers without human intervention. Supporting signals remain
many-to-many because names, addresses, and phones can be shared, reused, or entered inconsistently.

Add source-resolution audit:

```sql
CREATE TABLE IF NOT EXISTS source_identity_resolutions (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('resolved','needs_review')),
  customer_id TEXT,
  reason TEXT NOT NULL,
  matched_signals_json TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
```

**Idempotency (review 2026-07-04) — required, not optional.** A source is reprocessed on job
retry (lease expiry / backoff) and, crucially, whenever `IdentityReviewClient` (Task 6) enqueues
a fresh job to re-run an ambiguous source. Both identity writes therefore MUST be idempotent or
the second run throws on a constraint and the job retries forever:

- `customer_identity_signals` has `UNIQUE(customer_id, signal_type, signal_value)`. `insertSignal`
  should be idempotent for the same customer/signal/source retry, but must not hide a hard-signal
  collision. Implement it as: attempt the insert; if it is ignored or conflicts, look up
  `(signal_type, signal_value)`. If the existing customer is the same customer, treat it as a
  retry/no-op. If the existing customer is different and the signal is hard, return/throw an
  `IdentitySignalConflictError` so the source goes to review.
- Hard signals also have a global partial unique index on `(signal_type, signal_value)` for
  `fein` and `email`, so one exact hard identifier cannot silently attach to two customers.
  If that insert conflicts, treat it as an identity-review case rather than swallowing it or
  letting the processor turn it into a generic retry loop.
- `source_identity_resolutions` has `source_id` as PRIMARY KEY — insert with an upsert
  (`INSERT INTO … ON CONFLICT(source_id) DO UPDATE SET …`), so a re-resolution overwrites the
  prior verdict (e.g. `needs_review` → `resolved` after a human attach) instead of colliding.

Keep customer-scoped tables customer-scoped:

```text
facts / extracted_field_candidates.customer_id stays NOT NULL
collection_items.customer_id stays NOT NULL
form_drafts.customer_id stays NOT NULL
outbox.customer_id stays NOT NULL
conflicts / field_conflicts.customer_id stays NOT NULL
```

---

## Resolution Rules

Normalize signals deterministically:

```ts
fein: digits only, e.g. "12-3456789" -> "123456789"
email: lowercase + trim
phone: digits only
business_name_state: lowercase, punctuation collapsed, with state suffix when state exists
mailing_address: lowercase, punctuation collapsed, street/city/state/zip joined
```

Build a usable identity signal only when all of these are true:

```text
presence === 'present'
value is non-empty after normalization
evidence is present in the transcript with match_quality exact or normalized
format is valid for the signal type
```

The `match_quality` check is NOT read off the envelope — `ExtractionEnvelope` fields carry only
`{ value, presence, confidence, evidence }`, no match_quality. Compute it by calling the existing
provenance matcher `locateEvidence(transcript, field.evidence)` (`src/extraction/evidenceMatcher.ts`)
and accept the signal only when its `quality` is `exact` or `normalized`. This is the
anti-hallucination guard the resolver test "does not use a hallucinated identifier whose evidence
is not in the transcript" depends on. Note: a short evidence quote that occurs more than once in
the transcript returns `ambiguous` and is dropped (conservative — the signal simply won't
auto-resolve).

Format checks:

```text
fein: exactly 9 digits after normalization
email: basic local@domain shape after lowercase/trim
phone: 10 digits for US phone numbers in this challenge fixture
business_name_state: non-empty business name AND non-empty state
mailing_address: street, city, state, and zip all present
```

Only these hard signals may auto-resolve or auto-create a customer:

```text
fein
email
```

Note (review 2026-07-04): `email` is treated as hard for this challenge, but a freemail domain
(gmail/yahoo/outlook/etc.) is a weak business identifier — a production deployment should demote
freemail emails to supporting. `phone` was moved from hard to supporting below: phone numbers are
reassigned and shared, so auto-*merging* two sources on a phone match risks combining distinct
businesses, violating the non-negotiable "never treat an ambiguous match as the same customer"
invariant. (This is a change from the original plan text; if you want phone to remain a hard
auto-merge key, revert this and the Task 4 signal-strength line together.)

Supporting signals are stored and shown to reviewers, but do not merge customers by themselves:

```text
phone
business_name_state
mailing_address
```

Resolve in this order:

1. If all usable matched signals point to exactly one existing customer, and at least one matched signal is hard, resolve to that customer.
2. If usable hard signals match multiple different customers, return `needs_review`.
3. If a hard signal points to one customer but a supporting signal points to a different customer, return `needs_review`.
4. If no existing customer matches any usable signal and at least one usable hard signal exists, create a new customer and attach all usable signals.
5. If no hard signal matches but a supporting signal matches an existing customer, return `needs_review`; this may be an existing customer with a changed/new hard identifier.
6. If only supporting signals exist, return `needs_review` with candidate evidence; do not auto-attach and do not auto-create.
7. If a signal is only a fuzzy/partial/non-exact match to an existing customer, return `needs_review`.
8. If no usable signal exists, return `needs_review`.

Non-negotiable identity invariant: a non-exact or ambiguous match is never treated as the same
customer. It is either a new customer supported by a hard identifier or a human identity-review
case.

---

## Task 1: Extend Extraction Envelope With Identity Fields

**Files:**
- Modify: `src/schema/profile.ts`
- Test: `tests/schema/profile.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that parse the identity fields:

```ts
it('accepts identity fields used by customer resolution', () => {
  const parsed = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    business_phone: { value: '910-555-0173', presence: 'present', confidence: 0.95, evidence: '910-555-0173' },
    policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
  })
  expect(parsed.business_name?.value).toBe('Coastal Roofing LLC')
  expect(parsed.policyholder_email?.value).toBe('mike.torres@coastalroofing.com')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/profile.test.ts`

Expected: FAIL because `business_name`, `business_phone`, and `policyholder_email` are not in the schema.

- [ ] **Step 3: Add identity fields to `ExtractionEnvelope`**

Add:

```ts
business_name: envelopeField(z.string()).optional(),
business_phone: envelopeField(z.string()).optional(),
policyholder_email: envelopeField(z.string()).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/schema/profile.test.ts && npm run typecheck`

Expected: PASS and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/schema/profile.ts tests/schema/profile.test.ts
git commit -m "feat: add customer identity fields to extraction envelope"
```

---

## Task 2: Raw Transcript Webhook Contract

**Files:**
- Modify: `src/ingest/webhook.ts`
- Modify: `tests/ingest/webhook.test.ts`
- Create: `tests/ingest/webhookRawTranscript.test.ts`

- [ ] **Step 1: Write failing raw-payload test**

```ts
import transcriptFixture from '../../transcripts.json'

it('accepts the raw transcript shape from transcripts.json without customer_id', async () => {
  const [source] = transcriptFixture
  const res = await app.inject({ method: 'POST', url: '/webhook/transcript', payload: source })
  expect(res.statusCode).toBe(202)
  expect(JSON.parse(res.body).job_id).toBeTruthy()
  expect(countRows(db, 'sources')).toBe(1)
  expect(countRows(db, 'processing_jobs')).toBe(1)
  const row = db.prepare('SELECT customer_id, raw_json FROM sources WHERE id=?').get(source.id) as { customer_id: string | null; raw_json: string }
  expect(row.customer_id).toBeNull()
  expect(JSON.parse(row.raw_json).content).toContain('Coastal Roofing LLC')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ingest/webhookRawTranscript.test.ts`

Expected: FAIL because the handler currently requires `customer_id` and `source`.

- [ ] **Step 3: Replace webhook schema**

Use this Zod schema:

```ts
const RawTranscript = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  date: z.string().datetime({ message: 'date must be ISO-8601 UTC' }),
  participants: z.array(z.string()).min(1),
  content: z.string().min(1),
})
```

Persist `raw_json` as the full transcript object:

```ts
raw_json: JSON.stringify(b)
```

Compute checksum without customer identity:

```ts
const checksum = contentHash({ type: b.type, date: b.date, content: b.content })
```

Create job with only `source_id`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ingest/webhookRawTranscript.test.ts tests/ingest/webhook.test.ts`

Expected: PASS after updating old webhook tests to the raw source shape.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/webhook.ts tests/ingest
git commit -m "feat: accept raw transcript webhook payload"
```

---

## Task 3: Source And Job Schema Without Required Customer ID

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/repos/sources.ts`
- Modify: `src/db/repos/jobs.ts`
- Test: `tests/db/migrations.test.ts`, `tests/worker/processor.test.ts`

- [ ] **Step 1: Write failing migration assertions**

```ts
it('allows sources and jobs before customer identity is resolved', () => {
  const db = openDb(); migrate(db)
  expect(() => db.prepare(`INSERT INTO sources
    (id,type,source_date,received_at,raw_json,checksum,status)
    VALUES ('src_001','call_transcript','2025-03-12T10:30:00Z','2025-03-12T10:31:00Z','{}','h','received')`).run()
  ).not.toThrow()
  expect(() => db.prepare(`INSERT INTO processing_jobs
    (id,source_id,status,attempts,next_attempt_at,created_at)
    VALUES ('job_001','src_001','pending',0,'2025-03-12T10:31:00Z','2025-03-12T10:31:00Z')`).run()
  ).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migrations.test.ts`

Expected: FAIL because `customer_id` is currently required.

- [ ] **Step 3: Update schema and repos**

Change `SourceRow`:

```ts
export interface SourceRow {
  id: string
  customer_id: string | null
  type: string
  source_date: string
  received_at: string
  raw_json: string
  extraction_json: string | null
  checksum: string
  status: 'received' | 'resolved' | 'identity_needs_review' | 'dead'
}
```

Change `JobInsert`:

```ts
export interface JobInsert {
  id: string
  source_id: string
  next_attempt_at: string
  created_at: string
}
```

Add source repo methods:

```ts
attachCustomer(sourceId: string, customerId: string, now: string): void
saveExtraction(sourceId: string, extractionJson: string): void
markIdentityNeedsReview(sourceId: string): void
```

- [ ] **Step 4: Run migration and processor tests**

Run: `npx vitest run tests/db/migrations.test.ts tests/worker/processor.test.ts`

Expected: PASS after updating processor test setup to source-scoped jobs.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/repos/sources.ts src/db/repos/jobs.ts tests/db tests/worker
git commit -m "feat: make source ingest customer-agnostic"
```

---

## Task 4: Identity Signals And Customer Resolver

**Files:**
- Create: `src/identity/identitySignals.ts`
- Create: `src/db/repos/customerIdentity.ts`
- Create: `src/identity/customerResolver.ts`
- Test: `tests/identity/customerResolver.test.ts`

- [ ] **Step 1: Write failing resolver tests**

```ts
const transcript = [
  'Coastal Roofing LLC',
  'okay, it is 12-3456789',
  'mike.torres@coastalroofing.com',
  'my cell is 910-555-0173',
  'PO Box 9102, Wilmington, NC 28402',
].join('\n')

it('creates a new customer when hard identity signals have no existing match', () => {
  const env = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_001', now: clock.now(), transcript })
  expect(result.status).toBe('resolved')
  expect(result.customerId).toBeTruthy()
  expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([result.customerId])
})

it('resolves to an existing customer by FEIN', () => {
  const customerId = identity.createCustomerWithSignals({
    legalName: 'Coastal Roofing LLC',
    signals: [{ type: 'fein', value: '123456789', sourceId: 'seed' }],
    now: clock.now(),
  })
  const env = ExtractionEnvelope.parse({
    fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_002', now: clock.now(), transcript })
  expect(result).toMatchObject({ status: 'resolved', customerId })
})

it('returns needs_review when hard signals point to different customers', () => {
  identity.createCustomerWithSignals({ legalName: 'A', signals: [{ type: 'fein', value: '123456789', sourceId: 'seed1' }], now: clock.now() })
  identity.createCustomerWithSignals({ legalName: 'B', signals: [{ type: 'email', value: 'mike@x.com', sourceId: 'seed2' }], now: clock.now() })
  const env = ExtractionEnvelope.parse({
    fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    policyholder_email: { value: 'mike@x.com', presence: 'present', confidence: 0.95, evidence: 'mike@x.com' },
  })
  const conflictTranscript = '12-3456789\nmike@x.com'
  expect(resolver.resolve(env, { sourceId: 'src_003', now: clock.now(), transcript: conflictTranscript }).status).toBe('needs_review')
})

it('does not use a hallucinated identifier whose evidence is not in the transcript', () => {
  const env = ExtractionEnvelope.parse({
    fein: { value: '98-7654321', presence: 'present', confidence: 0.99, evidence: '98-7654321' },
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_004', now: clock.now(), transcript: 'Coastal Roofing LLC only' })
  expect(result.status).toBe('needs_review')
  expect(identity.findCustomersBySignal('fein', '987654321')).toEqual([])
})

it('does not auto-resolve or auto-create from business name/address alone', () => {
  const env = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_005', now: clock.now(), transcript })
  expect(result.status).toBe('needs_review')
})

it('does not auto-create when a new hard signal has an exact supporting match to an existing customer', () => {
  identity.createCustomerWithSignals({
    legalName: 'Coastal Roofing LLC',
    signals: [{ type: 'business_name_state', value: 'coastal roofing llc|nc', sourceId: 'seed' }],
    now: clock.now(),
  })
  const env = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    fein: { value: '98-7654321', presence: 'present', confidence: 0.95, evidence: '98-7654321' },
    mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_006', now: clock.now(), transcript: transcript.replace('12-3456789', '98-7654321') })
  expect(result.status).toBe('needs_review')
})

it('returns needs_review when hard and supporting signals match different customers', () => {
  identity.createCustomerWithSignals({ legalName: 'A', signals: [{ type: 'fein', value: '123456789', sourceId: 'seed1' }], now: clock.now() })
  identity.createCustomerWithSignals({ legalName: 'B', signals: [{ type: 'business_name_state', value: 'coastal roofing llc|nc', sourceId: 'seed2' }], now: clock.now() })
  const env = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_007', now: clock.now(), transcript })
  expect(result.status).toBe('needs_review')
})

it('does not treat a fuzzy business-name match as the same customer', () => {
  identity.createCustomerWithSignals({
    legalName: 'Coastal Roof LLC',
    signals: [{ type: 'business_name_state', value: 'coastal roof llc|nc', sourceId: 'seed' }],
    now: clock.now(),
  })
  const env = ExtractionEnvelope.parse({
    business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    mailing_address: { value: { street: 'PO Box 9102', city: 'Wilmington', state: 'NC', zip: '28402' }, presence: 'present', confidence: 0.9, evidence: 'PO Box 9102, Wilmington, NC 28402' },
  })
  const result = resolver.resolve(env, { sourceId: 'src_008', now: clock.now(), transcript })
  expect(result.status).toBe('needs_review')
})

it('does not allow the same hard signal to belong to two customers silently', () => {
  identity.createCustomerWithSignals({
    legalName: 'A',
    signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed1' }],
    now: clock.now(),
  })
  expect(() => identity.createCustomerWithSignals({
    legalName: 'B',
    signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed2' }],
    now: clock.now(),
  })).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/identity/customerResolver.test.ts`

Expected: FAIL because resolver modules do not exist.

- [ ] **Step 3: Implement signal extraction**

`identitySignalsFromEnvelope(env, transcript)` returns normalized, evidence-verified signals:

```ts
export type IdentitySignalType = 'fein' | 'email' | 'phone' | 'business_name_state' | 'mailing_address'
export type IdentitySignalStrength = 'hard' | 'supporting'
export interface IdentitySignal { type: IdentitySignalType; value: string; strength: IdentitySignalStrength }
```

Rules:

```ts
drop every field whose presence is not 'present'
drop every field whose evidence fails locateEvidence(transcript, evidence) (quality not exact/normalized)
FEIN -> digits only; keep only exactly 9 digits; strength hard
email -> lowercase trim; keep only local@domain-shaped values; strength hard
phone -> digits only; keep only 10-digit US values for this fixture; strength SUPPORTING (see Resolution Rules)
business_name_state -> normalized business_name plus mailing_address.state when present; strength supporting
mailing_address -> normalized street|city|state|zip; strength supporting
```

Evidence verification uses the existing matcher — `import { locateEvidence } from
'../extraction/evidenceMatcher.js'` — not a bespoke substring check; accept only
`quality === 'exact' || quality === 'normalized'`.

- [ ] **Step 4: Implement repo and resolver**

`CustomerIdentityRepo` methods:

```ts
export class IdentitySignalConflictError extends Error {
  constructor(
    public readonly signalType: IdentitySignalType,
    public readonly signalValue: string,
    public readonly existingCustomerId: string,
  ) {
    super(`hard identity signal already belongs to ${existingCustomerId}`)
  }
}

createCustomer(args: { legalName: string | null; dba: string | null; owner: string | null; now: string }): string
insertSignal(customerId: string, signal: IdentitySignal, sourceId: string, now: string): void  // idempotent for same customer; hard-signal collision throws IdentitySignalConflictError
findCustomersBySignal(type: IdentitySignalType, value: string): string[]  // searches hard AND supporting signals; resolver decides what can auto-resolve
createCustomerWithSignals(args: { legalName: string | null; signals: Array<{ type: IdentitySignalType; value: string; strength?: IdentitySignalStrength; sourceId: string }>; now: string }): string
insertResolution(args: { sourceId: string; status: 'resolved' | 'needs_review'; customerId: string | null; reason: string; matchedSignalsJson: string; now: string }): void  // UPSERT on source_id (ON CONFLICT DO UPDATE) — re-resolution overwrites, never collides
```

`createCustomerWithSignals` is a seed/helper method for tests and manual setup. If `strength` is
omitted, infer it from the type (`fein`/`email` hard; everything else supporting) so test setup
does not need to repeat the production signal-strength table.

`CustomerResolver.resolve(env, ctx)` returns:

```ts
type CustomerResolution =
  | { status: 'resolved'; customerId: string; reason: string }
  | { status: 'needs_review'; reason: string }

interface ResolveCtx { sourceId: string; now: string; transcript: string }
```

Resolver algorithm:

```ts
const signals = identitySignalsFromEnvelope(env, ctx.transcript)
const hardSignals = signals.filter(s => s.strength === 'hard')
const supportingSignals = signals.filter(s => s.strength === 'supporting')
const matchedSignalsJson = JSON.stringify(signals)
const unique = <T>(items: T[]): T[] => [...new Set(items)]

if (hardSignals.length === 0) {
  repo.insertResolution({
    sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
    reason: 'no_usable_hard_identity_signal', matchedSignalsJson, now: ctx.now,
  })
  return { status: 'needs_review', reason: 'no_usable_hard_identity_signal' }
}

const hardMatchedCustomerIds = unique(hardSignals.flatMap(s => repo.findCustomersBySignal(s.type, s.value)))
const supportingMatchedCustomerIds = unique(supportingSignals.flatMap(s => repo.findCustomersBySignal(s.type, s.value)))
const allMatchedCustomerIds = unique([...hardMatchedCustomerIds, ...supportingMatchedCustomerIds])

// findCustomersBySignal searches every signal type. Supporting matches are safety evidence:
// they can force needs_review when they disagree with a hard match, or when a new hard
// identifier appears to belong to an existing customer by exact name/address. They never
// auto-resolve a source by themselves.

const insertSignalsOrNeedsReview = (customerId: string): CustomerResolution | undefined => {
  try {
    for (const signal of signals) repo.insertSignal(customerId, signal, ctx.sourceId, ctx.now)
    return undefined
  } catch (e) {
    if (!(e instanceof IdentitySignalConflictError)) throw e
    repo.insertResolution({
      sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
      reason: 'hard_identity_signal_conflict', matchedSignalsJson, now: ctx.now,
    })
    return { status: 'needs_review', reason: 'hard_identity_signal_conflict' }
  }
}

if (allMatchedCustomerIds.length > 1) {
  repo.insertResolution({
    sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
    reason: 'conflicting_identity_signals', matchedSignalsJson, now: ctx.now,
  })
  return { status: 'needs_review', reason: 'conflicting_identity_signals' }
}

if (hardMatchedCustomerIds.length === 1) {
  const customerId = hardMatchedCustomerIds[0]!
  const conflict = insertSignalsOrNeedsReview(customerId)
  if (conflict) return conflict
  repo.insertResolution({
    sourceId: ctx.sourceId, status: 'resolved', customerId,
    reason: 'matched_hard_identity_signal', matchedSignalsJson, now: ctx.now,
  })
  return { status: 'resolved', customerId, reason: 'matched_hard_identity_signal' }
}

if (supportingMatchedCustomerIds.length === 1) {
  repo.insertResolution({
    sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
    reason: 'supporting_match_without_hard_match', matchedSignalsJson, now: ctx.now,
  })
  return { status: 'needs_review', reason: 'supporting_match_without_hard_match' }
}

const legalName = env.business_name?.presence === 'present' && typeof env.business_name.value === 'string'
  ? env.business_name.value
  : null
const dba = env.dba_name?.presence === 'present' && typeof env.dba_name.value === 'string'
  ? env.dba_name.value
  : null
const owner = [
  env.policyholder_first_name?.value,
  env.policyholder_last_name?.value,
].filter(v => typeof v === 'string' && v.length > 0).join(' ') || null

const customerId = repo.createCustomer({ legalName, dba, owner, now: ctx.now })
const conflict = insertSignalsOrNeedsReview(customerId)
if (conflict) return conflict
repo.insertResolution({
  sourceId: ctx.sourceId, status: 'resolved', customerId,
  reason: 'created_from_hard_identity_signal', matchedSignalsJson, now: ctx.now,
})
return { status: 'resolved', customerId, reason: 'created_from_hard_identity_signal' }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/identity/customerResolver.test.ts && npm run typecheck`

Expected: PASS and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/identity src/db/repos/customerIdentity.ts tests/identity/customerResolver.test.ts
git commit -m "feat: resolve raw transcript identity to customers"
```

---

## Task 5: Processor Resolves Identity Before Facts

**Files:**
- Modify: `src/worker/processor.ts`
- Modify: `src/server.ts`
- Test: `tests/worker/processorIdentity.test.ts`

- [ ] **Step 1: Write failing processor identity tests**

```ts
it('extracts identity, creates a customer, then persists facts under that customer', async () => {
  insertSourceAndJob(db, {
    source: { id: 'src_001', customer_id: null, type: 'call_transcript', source_date: '2025-03-12T10:30:00Z',
      received_at: '2025-03-12T10:31:00Z',
      // Mirror the exact production webhook shape (Task 2 persists `JSON.stringify(b)` where
      // b is the full RawTranscript), not a simplified { content } — no test/production drift.
      raw_json: JSON.stringify({ id: 'src_001', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: transcript }),
      extraction_json: null, checksum: 'x', status: 'received' },
    job: { id: 'job_001', source_id: 'src_001', next_attempt_at: '2025-03-12T10:31:00Z', created_at: '2025-03-12T10:31:00Z' },
  })
  expect(await makeProcessor().drainOnce()).toBe(1)
  const source = new SourcesRepo(db).get('src_001')!
  expect(source.customer_id).toBeTruthy()
  expect(source.status).toBe('resolved')
  expect(new FactsRepo(db).byField(source.customer_id!, 'annual_gross_revenue')).toHaveLength(1)
})

it('does not insert customer-scoped facts when identity is ambiguous', async () => {
  seedTwoCustomersWithConflictingSignals()
  insertRawSourceAndJob('src_ambiguous')
  expect(await makeProcessor().drainOnce()).toBe(1)
  expect(new SourcesRepo(db).get('src_ambiguous')!.status).toBe('identity_needs_review')
  expect(db.prepare('SELECT COUNT(*) n FROM facts').get()).toMatchObject({ n: 0 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/processorIdentity.test.ts`

Expected: FAIL because processor still reads `job.customer_id`.

- [ ] **Step 3: Update processor ordering**

Processor order becomes:

```text
claim job
load raw source
if source.extraction_json is present:        # re-run of an already-extracted source
  env = ExtractionEnvelope.parse(JSON.parse(source.extraction_json)) # reuse and re-validate; do NOT call the LLM again
else:
  env = await llm.extract(transcript)        # the ONLY async/network work, OUTSIDE any transaction
transaction:
  save extraction_json (idempotent — OR REPLACE / no-op when already stored)
  if source.customer_id is already set:      # manual identity-review attach path
    customerId = source.customer_id
    mark source resolved
  else:
    resolve customer identity                # resolver writes are idempotent (see Task 4)
    if needs_review:
      mark source identity_needs_review
      complete job
      return
  attach source to customer
  extractFacts(env, { customerId })
  insert facts / candidates
  reconcile
  project forms
  complete job (fenced — throw to roll back if lease lost)
```

Never insert facts before `customerId` is resolved. The `extraction_json` reuse branch is what
lets `IdentityReviewClient` (Task 6) requeue an ambiguous source and have it resolve to the
human-chosen customer **without a second LLM call**. The processor must respect
`source.customer_id` when it is already set by review; do not run the automatic resolver again
and loop back to `identity_needs_review`. This also makes any retry of an already-resolved source
cheap and side-effect-free (all writes below are idempotent).

- [ ] **Step 4: Run processor and integration tests**

Run: `npx vitest run tests/worker/processorIdentity.test.ts tests/worker/processor.test.ts tests/integration/pipeline.test.ts`

Expected: PASS after updating test fixtures to raw source jobs.

- [ ] **Step 5: Commit**

```bash
git add src/worker/processor.ts src/server.ts tests/worker tests/integration
git commit -m "feat: resolve customer identity before profile persistence"
```

---

## Task 6: Identity Review Client For Ambiguous Sources

**Files:**
- Create: `src/review/identityReviewClient.ts`
- Test: `tests/review/identityReviewClient.test.ts`

- [ ] **Step 1: Write failing review tests**

```ts
it('lets a reviewer attach an ambiguous source to an existing customer and requeue it', () => {
  const customerId = seedCustomer()
  seedSource({
    id: 'src_ambiguous',
    status: 'identity_needs_review',
    customer_id: null,
    raw_json: JSON.stringify({ id: 'src_ambiguous', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: 'reviewed manually' }),
    extraction_json: JSON.stringify(fixture),
  })
  const result = client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' })
  expect(result.status).toBe('resolved')
  expect(new ProcessingJobsRepo(db).get(result.jobId)!.status).toBe('pending')
  expect(new SourcesRepo(db).get('src_ambiguous')!.customer_id).toBe(customerId)
})

it('stores verified identity signals when a reviewer attaches a source', () => {
  const customerId = seedCustomer()
  seedSource({
    id: 'src_ambiguous',
    status: 'identity_needs_review',
    customer_id: null,
    raw_json: JSON.stringify({
      id: 'src_ambiguous',
      type: 'call_transcript',
      date: '2025-03-12T10:30:00Z',
      participants: ['Sarah Chen (Agent)', 'Mike Torres'],
      content: 'Coastal Roofing LLC\n12-3456789\nmike.torres@coastalroofing.com',
    }),
    extraction_json: JSON.stringify({
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
      policyholder_email: { value: 'mike.torres@coastalroofing.com', presence: 'present', confidence: 0.95, evidence: 'mike.torres@coastalroofing.com' },
      business_name: { value: 'Coastal Roofing LLC', presence: 'present', confidence: 0.95, evidence: 'Coastal Roofing LLC' },
    }),
  })
  expect(client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' }).status).toBe('resolved')
  expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([customerId])
  expect(identity.findCustomersBySignal('email', 'mike.torres@coastalroofing.com')).toEqual([customerId])
})

it('does not attach or requeue when manual attach conflicts with an existing hard signal', () => {
  const existingCustomerId = identity.createCustomerWithSignals({
    legalName: 'Existing Business',
    signals: [{ type: 'fein', value: '123456789', strength: 'hard', sourceId: 'seed' }],
    now: clock.now(),
  })
  const chosenCustomerId = seedCustomer()
  seedSource({
    id: 'src_conflict',
    status: 'identity_needs_review',
    customer_id: null,
    raw_json: JSON.stringify({
      id: 'src_conflict',
      type: 'call_transcript',
      date: '2025-03-12T10:30:00Z',
      participants: ['Sarah Chen (Agent)', 'Mike Torres'],
      content: '12-3456789',
    }),
    extraction_json: JSON.stringify({
      fein: { value: '12-3456789', presence: 'present', confidence: 0.95, evidence: '12-3456789' },
    }),
  })
  const result = client.resolveSourceToCustomer('src_conflict', chosenCustomerId, { by: 'sarah' })
  expect(result).toMatchObject({ status: 'needs_review', reason: 'hard_identity_signal_conflict' })
  expect(new SourcesRepo(db).get('src_conflict')!.customer_id).toBeNull()
  expect(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE source_id='src_conflict' AND status='pending'").get()).toMatchObject({ n: 0 })
  expect(identity.findCustomersBySignal('fein', '123456789')).toEqual([existingCustomerId])
})

it('processes a reviewer-attached source under the chosen customer instead of looping to identity review', async () => {
  const customerId = seedCustomer()
  seedSource({
    id: 'src_ambiguous',
    status: 'identity_needs_review',
    customer_id: null,
    raw_json: JSON.stringify({ id: 'src_ambiguous', type: 'call_transcript', date: '2025-03-12T10:30:00Z', participants: ['Sarah Chen (Agent)', 'Mike Torres'], content: 'reviewed manually' }),
    extraction_json: JSON.stringify(fixture),
  })
  client.resolveSourceToCustomer('src_ambiguous', customerId, { by: 'sarah' })
  expect(await makeProcessorWithThrowingLlm().drainOnce()).toBe(1) // extraction_json is reused; no second LLM call
  const source = new SourcesRepo(db).get('src_ambiguous')!
  expect(source.status).toBe('resolved')
  expect(source.customer_id).toBe(customerId)
  expect(new FactsRepo(db).byField(customerId, 'annual_gross_revenue').length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/review/identityReviewClient.test.ts`

Expected: FAIL because `IdentityReviewClient` does not exist.

- [ ] **Step 3: Implement `IdentityReviewClient`**

Method:

```ts
type IdentityReviewResolution =
  | { status: 'resolved'; jobId: string }
  | { status: 'needs_review'; reason: 'hard_identity_signal_conflict' }

resolveSourceToCustomer(sourceId: string, customerId: string, opts: { by: string }): IdentityReviewResolution
```

Transaction:

```text
verify source.status = identity_needs_review
parse source.extraction_json with ExtractionEnvelope.parse
parse source.raw_json and read .content
build verified identity signals with identitySignalsFromEnvelope(env, transcript)
insert every verified signal for the chosen customer with CustomerIdentityRepo.insertSignal
if insertSignal throws IdentitySignalConflictError:
  leave source.customer_id NULL and status identity_needs_review
  upsert source_identity_resolutions with status='needs_review',
    reason='hard_identity_signal_conflict', resolved_by/resolved_at set from reviewer + Clock
  return { status: 'needs_review', reason: 'hard_identity_signal_conflict' }
attach source.customer_id
upsert source_identity_resolutions with status='resolved', customer_id=<chosen customer>,
  reason='manual_identity_review', matched_signals_json=<verified signals>,
  resolved_by/resolved_at set from reviewer + Clock
insert a new pending processing job for the source
return { status: 'resolved', jobId }
```

Manual review should teach the identity index, not only fix one source. The processor then reuses
`sources.extraction_json` when present and respects the attached `sources.customer_id`, so manual
resolution does not need another LLM call and does not loop back through automatic identity review.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/review/identityReviewClient.test.ts && npm run typecheck`

Expected: PASS and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/review/identityReviewClient.ts tests/review/identityReviewClient.test.ts
git commit -m "feat: add identity review resolution path"
```

---

## Task 7: Documentation And Invariant Updates

**Files:**
- Modify: `AGENTS.md`
- Modify: `DESIGN_DOC.md`
- Modify: `docs/superpowers/plans/2026-07-04-field-review-versions.md`

- [ ] **Step 1: Update `AGENTS.md`**

Add an invariant:

```md
**Raw transcript identity resolution.** The webhook payload does not contain `customer_id`.
Raw `sources` may be customerless, but customer-scoped tables (`facts` /
`extracted_field_candidates`, `collection_items`, `form_drafts`, `outbox`, conflicts) must
never receive rows until identity resolution has attached a stable `customer_id`.
```

- [ ] **Step 2: Update field-review plan dependency**

At the top of `2026-07-04-field-review-versions.md`, add:

```md
**Prerequisite:** Complete `2026-07-04-customer-identity-resolution.md` first. This plan assumes
sources are already attached to a stable `customer_id` before field candidates are inserted.
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
rg -n "customer_id" src/ingest tests/ingest
rg -n "facts.insertMany|extractFacts" src/worker/processor.ts
rg -n "fein|12-3456789|@coastalroofing" tests/integration/pipeline.test.ts
```

Expected:

- Full tests pass.
- Typecheck clean.
- Ingest tests no longer build webhook payloads with `customer_id`.
- Processor resolves identity before `extractFacts` and before candidate insertion.
- **Self-heal check:** the correcting transcript in the ACORD-703 e2e fixture carries a hard
  identifier (FEIN or email) so transcript 2 auto-resolves to the SAME customer as transcript 1
  and the conflict/self-heal path still runs end-to-end. If it does not, either add the identifier
  to the fixture or route it through `IdentityReviewClient` before re-asserting the self-heal —
  do not let the e2e silently stop at `identity_needs_review`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md DESIGN_DOC.md docs/superpowers/plans src tests
git commit -m "docs: document raw transcript identity-resolution requirement"
```

---

## Self-Review

Spec coverage:

- Raw `transcripts.json` payload accepted without `customer_id`: Task 2.
- Durable raw source ingest before identity exists: Task 3.
- Explicit customer identity resolution before customer-scoped writes: Tasks 4 and 5.
- Ambiguous identity does not auto-merge customers: Tasks 4, 5, and 6.
- Manual identity review teaches the identity index and does not requeue hard-signal conflicts:
  Task 6.
- Existing form/review/outbox model remains customer-scoped: Task 5.
- Field-review-version plan dependency documented: Task 7.

Architecture check:

- Webhook remains a thin adapter.
- Identity matching is isolated under `src/identity`.
- Persistence details stay in repos.
- Processor coordinates the use case but does not embed matching rules.
- No customer-scoped table receives rows until identity resolution returns one customer ID.

Execution options:

1. **Subagent-Driven (recommended)** - dispatch one task at a time and review after each.
2. **Inline Execution** - execute this plan in the current session with checkpoints.
