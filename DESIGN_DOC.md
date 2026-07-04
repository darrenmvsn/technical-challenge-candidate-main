Design Decision

The transcript payload has:

```text
id
type
date
participants
content
```

It does not have any `customer_id`.

So the system cannot immediately write extracted values to customer-scoped tables. First it
stores the raw transcript, extracts identity signals, resolves the customer, and only then
persists customer profile data.

## Decision

Use a normalized pipeline:

```text
raw transcript
  -> source
  -> identity resolution
  -> customer
  -> extracted field candidates
  -> human review versions
  -> current profile projection
  -> form draft / outbox snapshot
```

This replaces the simpler "one big customer/form JSON row" design.

## How the System Works, End to End

The pipeline runs in four stages. Each stage owns one durable step and hands off
through the database, never through a shared in-memory call. The integration test
(`tests/integration/pipeline.test.ts`) drives exactly this path.

### 1. Ingest (webhook)

A transcript arrives at `POST /webhook/transcript`. The payload is validated at the
boundary, then stored as a `sources` row and a queued `processing_jobs` row — in one
transaction. The webhook returns `202` immediately; it does no extraction. The
transcript is now durable even though no customer is attached yet.

### 2. Process (Processor)

A worker claims the job under a fenced lease and runs one job to completion:

1. **Extract.** The raw transcript goes to the LLM, which returns a schema-validated
  envelope of field candidates (value, presence, confidence, evidence quote). This is
   the only network call, and it happens *before* the database transaction.
2. **Resolve identity.** The webhook payload has no `customer_id`. The processor reads
  hard signals (FEIN, business email) from the extraction and either matches an
   existing customer or creates one. Weak/ambiguous signals stop the source at
   `needs_review` instead of guessing.
3. **Persist — all or nothing.** Once identity is attached, one transaction writes the
  evidence candidates, reconciles them against any prior reviewed value, projects the
   current profile into a `form_drafts` row, and fences the job complete. If the
   completion fence fails, none of it persists.

After this stage the customer exists, evidence is stored, and a draft reflects the
machine's best current value.

### 3. Review + approve (ReviewClient)

A human reviews the draft and calls `approveForm`. Approval never mutates evidence — it
writes an immutable `field_review_versions` row (`approved` / `edited` /
`accepted_conflict` / `approved_blank`). This is the record of human intent. Approving
enqueues an `outbox` row carrying the exact fill payload and its content hash.

### 4. Fill (OutboxWorker)

The worker claims the pending outbox row under a lease and fills the PDF — an external
side effect kept strictly outside any transaction. The blob is written to a
content-addressed key `pdf/{customerId}/{formType}/{contentHash}`, and the draft is
marked `filled`. Retries and crashes are safe: the same payload always fills to the same
key, so re-running never duplicates a fill.

### What happens on a correction

A later transcript can disagree with an already-approved value. This is the case the
design exists to handle safely:

- The new evidence is stored as a **new candidate** — the first is never rewritten.
- Because the current value was already approved, the reconciler does **not** overwrite
it. It opens a `field_conflicts` row and waits. The re-projected draft still shows the
approved value.
- The already-filled PDF from the first approval is **immutable** — it is superseded, not
mutated, and its blob bytes are untouched.
- When the reviewer accepts the correction, that single human act writes an
`accepted_conflict` review version, resolves the conflict, and enqueues a fresh fill.
The new value fills to a *different* content-addressed key; the original fill still
exists byte-for-byte.

The end-to-end guarantee: every value on a filled form traces to either machine evidence
or a human decision, a later disagreement always surfaces as a visible conflict rather
than a silent overwrite, and every filled PDF stays reproducible.

## Database Shape

### `sources`

Stores the raw webhook payload.

A source may start without a customer:

```text
id
customer_id nullable
type
source_date
received_at
raw_json
extraction_json
checksum
status
```

This lets us durably store transcripts before identity is resolved.

### `customer_identity_signals`

Stores normalized identity keys for customers.

```text
customer_id
signal_type   -- fein, email, phone, business_name_state, mailing_address
signal_value
source_id
```

Hard auto-match signals:

```text
FEIN
business email
```

Supporting-only signals:

```text
phone
business name + state
mailing address
```

Supporting signals can block unsafe matches, but they do not merge customers by themselves.

### `source_identity_resolutions`

Audits how a source was resolved.

```text
source_id
status        -- resolved | needs_review
customer_id
reason
matched_signals_json
resolved_by
resolved_at
```

If identity is weak, fuzzy, conflicting, or missing, the source stops here for review.

### Why identity resolution is strict

The system only auto-attaches a transcript to a customer when it has a strong, evidence-verified
identifier: FEIN or business email.

Phone, business name, and address are supporting signals. They are useful context, but they are
not safe enough to merge customers by themselves. Phone numbers can be reused, names can be
similar, and addresses can be shared or entered inconsistently.

The tradeoff is that some real matches will need human review. That is intentional. A missed
auto-match is cheaper to fix than accidentally merging two different businesses.

### `extracted_field_candidates`

Stores machine-extracted field values.

```text
id
customer_id
field_path
value_json
presence
confidence
evidence_quote
evidence_span_start
evidence_span_end
match_quality
source_id
source_date
extracted_at
superseded_by
```

These rows are machine evidence, not approved truth.

Example:

```text
annual_gross_revenue = 2500000
source_id = transcript_1
confidence = 0.91
evidence_quote = "about two point five million"
```

If a later transcript says revenue is `2800000`, we insert a second candidate. We do not
rewrite the first one.

### `field_review_versions`

Stores human decisions.

```text
id
customer_id
field_path
version
candidate_id
value_json
presence
action        -- approved | edited | accepted_conflict | approved_blank
reviewed_by
reviewed_at
```

Every approval or edit creates a new version. The latest version is the current reviewed
value.

### Why evidence is immutable

Extracted candidates are audit records: what the machine extracted, from which source, with what
evidence. We do not rewrite those rows when a human approves, edits, or corrects a value.

Human decisions are written as new `field_review_versions`. The current profile is computed from
machine evidence plus the latest human review. That gives us a clear audit trail: we can explain
both what the transcript said and what the reviewer decided.

The tradeoff is one extra join/projection step when reading the current profile. The benefit is
that historical evidence and approval history stay intact.

### `field_conflicts`

Stores cases where new machine evidence disagrees with the latest reviewed value.

```text
id
customer_id
field_path
current_candidate_id
conflicting_candidate_id
status
resolved_by_review_version_id
resolved_by
resolved_at
created_at
```

The system does not silently replace reviewed data. It creates a conflict and waits for review.

### `form_drafts` and `outbox`

These store snapshots.

Once a draft or PDF payload is created, it stays reproducible even if newer transcripts arrive
later.

### Why use the outbox pattern?

Filling a PDF is an external side effect. It may call another service, write a blob, fail
halfway through, time out, or be retried after a worker crash.

We do not want form approval and PDF generation to happen as one fragile request:

```text
reviewer approves form
  -> update database
  -> call PDF service immediately
  -> hope both succeeded
```

Instead, approval writes an `outbox` row in the database:

```text
id
customer_id
form_type
draft_revision
payload_json
content_hash
status        -- pending | processing | done | dead | cancelled
attempts
next_attempt_at
locked_until
lock_token
locked_by
created_at
```

Then `OutboxWorker` claims pending rows and fills PDFs asynchronously.

This gives us:

- durable work: approved fills survive process crashes,
- retries with backoff when PDF generation fails,
- lease-based claiming so two workers do not complete the same row at the same time,
- cancellation of stale pending rows when a newer approval supersedes them,
- reproducible payloads because `payload_json` and `content_hash` are stored before fill time.

The tradeoff is eventual consistency. Approval can succeed before the PDF is filled. That means
we need a worker loop, retry/dead-letter handling, lease fencing, and status monitoring. The
benefit is that database state and external PDF generation are no longer coupled to one brittle
request path.

### Why processing is idempotent and lease-based

Workers can crash, lose a lease, or retry the same job after a timeout. The design assumes that
any processing job or outbox row may run more than once.

So writes are idempotent where possible: retrying the same source or fill should not create
duplicate facts, duplicate approvals, or a different PDF payload. Lease tokens prevent two
workers from completing the same row at the same time, and fenced completion prevents an old
worker from marking stale work as done after it has lost ownership.

The tradeoff is more status fields and retry bookkeeping. The benefit is predictable recovery:
crashes and retries become normal operating conditions, not data-corruption events.

## Current Value Rule

The current customer profile is computed, not stored directly.

```text
selected machine candidate
+ latest human review version, if one exists
= current field value
```

Example:

```text
Candidate A:
annual_gross_revenue = 2500000

Review version 1:
approved annual_gross_revenue = 2500000

Candidate B from later transcript:
annual_gross_revenue = 2800000
```

Current value remains:

```text
2500000
```

because that is the latest reviewed value.

The new `2800000` candidate opens a conflict. If the reviewer accepts it, the system writes:

```text
Review version 2:
accepted_conflict annual_gross_revenue = 2800000
```

Now the current value becomes:

```text
2800000
```

## Tradeoff

This is more tables than a single JSON blob, but it gives us:

- safe customer identity resolution,
- no accidental customer merges,
- reusable fields across multiple ACORD forms,
- correction handling,
- full audit history,
- reproducible form and outbox snapshots.

The key rules are:

```text
Raw sources can exist without customers.
Customer-scoped data cannot exist until identity is resolved.
Machine extraction is stored separately from human approval.
```

