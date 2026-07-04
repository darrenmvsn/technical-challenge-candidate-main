/**
 * All CREATE TABLE / CREATE INDEX DDL for the ACORD extraction pipeline (spec's Data
 * Model). Every statement is idempotent (`IF NOT EXISTS`) so `migrate()` is safe to
 * re-run against an existing DB.
 *
 * Finite-state columns carry a `CHECK` constraint (AGENTS.md invariant #11) mirroring the
 * enums in `src/schema/profile.ts` / `src/schema/forms.ts`:
 *   - extracted_field_candidates.presence      -> presenceValues
 *   - extracted_field_candidates.match_quality -> MatchQuality
 *   - field_review_versions.action             -> ReviewAction
 *   - processing_jobs.status -> pending|processing|done|dead
 *   - outbox.status          -> pending|processing|done|dead|cancelled
 *   - form_drafts.status     -> needs_review|approved|filled
 *   - form_drafts.form_type / outbox.form_type -> FormType
 *   - field_conflicts.status -> unresolved|resolved
 *   - sources.status         -> received|resolved|identity_needs_review|dead
 *
 * AGENTS.md invariant #7 (rewritten by this ticket): `extracted_field_candidates` stores ONLY
 * immutable machine/source evidence -- no human-review columns. Human decisions are immutable
 * rows in `field_review_versions`, one monotonically-increasing `version` per (customer_id,
 * field_path). The current canonical value is computed by overlaying the latest review version
 * on the machine-selected candidate (see `src/profile/candidateSelector.ts`), not stored as a
 * mutable column on the candidate row.
 *
 * `collection_items.collection` is intentionally left unconstrained: the spec never defines a
 * closed set for it (collections are an open, mechanically-extensible set per the scope
 * guardrails) — inventing enum values would be speculative, not spec-derived. `sources.status`
 * IS a closed set (a source moves received -> resolved / identity_needs_review, or dead) now
 * that identity resolution happens after ingest, so it carries a CHECK constraint (invariant #11).
 * `customer_id` on sources is nullable: a source is ingested BEFORE its customer identity is
 * resolved (the processor resolves it later), so it has no customer at insert time.
 *
 * Queue/current-read hot paths get supporting indexes: job/outbox claim queries filter on
 * (status, next_attempt_at); the "current candidate"/"current draft" reads filter on
 * (customer_id, field_path/form_type, superseded_by/superseded_by_revision); conflict
 * listing filters on (customer_id, status); source dedup checks by checksum. The checksum
 * index is UNIQUE because checksum is the durable content-identity dedupe key.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT, dba TEXT, owner TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, customer_id TEXT, type TEXT NOT NULL,
  source_date TEXT NOT NULL, received_at TEXT NOT NULL, raw_json TEXT NOT NULL,
  extraction_json TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','resolved','identity_needs_review','dead'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_checksum_unique ON sources(checksum);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, locked_until TEXT, lock_token TEXT, locked_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_claim ON processing_jobs(status, next_attempt_at);

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

CREATE TABLE IF NOT EXISTS collection_items (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, collection TEXT NOT NULL,
  natural_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(customer_id, collection, natural_key)
);

CREATE TABLE IF NOT EXISTS form_drafts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('acord_125','acord_126')),
  revision INTEGER NOT NULL, projected_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','approved','filled')),
  approved_by TEXT, approved_at TEXT,
  pdf_ref TEXT, superseded_by_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(customer_id, form_type, revision)
);
CREATE INDEX IF NOT EXISTS idx_form_drafts_current ON form_drafts(customer_id, form_type, superseded_by_revision);

CREATE TABLE IF NOT EXISTS draft_field_bindings (
  draft_id TEXT NOT NULL, form_field_path TEXT NOT NULL, profile_field_path TEXT NOT NULL,
  PRIMARY KEY (draft_id, form_field_path)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('acord_125','acord_126')),
  draft_revision INTEGER NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, locked_until TEXT, lock_token TEXT, locked_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON outbox(status, next_attempt_at);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_conflicts_open_unique
  ON field_conflicts(customer_id, conflicting_candidate_id)
  WHERE status = 'unresolved';

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
`
