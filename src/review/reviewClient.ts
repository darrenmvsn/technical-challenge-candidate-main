import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import type { FactsRepo } from '../db/repos/facts.js'
import type { DraftsRepo, DraftRow } from '../db/repos/drafts.js'
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

/** Per-field provenance surfaced to a human reviewer alongside the flat review value. */
export interface FieldProvenance {
  quote: string | null
  span: [number, number | null] | null
  confidence: number
  presence: string
  review_status: string
  /** A human has signed off on this field being blank (approved while non-'present'). */
  approved_blank: boolean
}
export interface DraftField { formFieldPath: string; value: unknown; provenance: FieldProvenance | null }
export interface DraftView { draft: DraftRow; fields: DraftField[] }

/**
 * Human-in-the-loop core of the pipeline. `getDraft` builds the FLAT review surface (what a
 * reviewer edits) with per-field provenance; `approveForm` writes the NESTED fill mapping (what
 * the PDF worker consumes) — see AGENTS.md Style §flat-vs-nested. The two shapes are never
 * mixed: `projected_json`/`draft_field_bindings` stay flat, only the outbox payload is nested.
 */
export class ReviewClient {
  constructor(private d: ReviewDeps) {}

  getDraft(customerId: string, formType: FormType): DraftView | undefined {
    const draft = this.d.drafts.current(customerId, formType)
    if (!draft) return undefined
    const mapping = JSON.parse(draft.projected_json) as Record<string, unknown>
    const bindings = this.d.drafts.getBindings(draft.id)
    const currentFacts = this.d.facts.currentMap(customerId)
    const fields: DraftField[] = Object.keys(mapping).map(formFieldPath => {
      const profilePath = reverseResolve(formType, formFieldPath, bindings)
      const fact = profilePath ? currentFacts.get(profilePath) : undefined
      return {
        formFieldPath,
        value: mapping[formFieldPath],
        provenance: fact ? {
          quote: fact.evidence_quote,
          span: fact.evidence_span_start !== null ? [fact.evidence_span_start, fact.evidence_span_end] : null,
          confidence: fact.confidence,
          presence: fact.presence,
          review_status: fact.review_status,
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

    // Everything below is synchronous SQLite work on `this.d.db` — no LLM/blob/network I/O ever
    // runs inside this transaction (AGENTS.md #5). `fillForm` is the worker's job (Task 14);
    // this only enqueues the nested payload it will later consume.
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
        const target = selectCurrentFact(facts.byField(customerId, profilePath))
        if (!target) throw new Error(`no fact for ${profilePath}`)
        facts.markApproved(target.id, JSON.stringify(value), by, now)
        editedPaths.push(profilePath)
      }

      // 2. Approve EVERY form-bound current fact (not just edits). A field that was never
      //    extracted (presence 'missing'/'needs_follow_up') is approved with its existing null
      //    value -> the read-side `approved_blank` state (sign-off on leaving it blank).
      //    Reviewer-initiated presence flips (`markNotApplicable`) are out of scope (deferred).
      const currentFacts = facts.currentMap(customerId)
      const boundPaths = new Set(renderForm(formType, currentFacts).fieldBindings.map(b => b.profile_field_path))
      for (const [path, fact] of currentFacts) {
        if (boundPaths.has(path) && fact.review_status !== 'approved') {
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
      let draftRow: DraftRow
      if (pending || current.status === 'filled') {
        if (pending) outbox.cancel(pending.id)
        draftRow = drafts.newRevision(customerId, formType, mapping, now)
      } else {
        draftRow = drafts.upsertProjection(customerId, formType, mapping, now)
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
