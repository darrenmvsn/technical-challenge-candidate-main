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
   * Reproject the current draft from fresh candidates.
   *  - no current row → create revision 1.
   *  - current is 'filled' → a filled draft is IMMUTABLE (its PDF may be at a carrier), so we
   *    mint a new needs_review revision and mark the old row superseded. Routed through
   *    newRevision() so `superseded_by_revision` is always set — never a dangling filled row
   *    with `superseded_by_revision IS NULL` (which would break the single-current invariant).
   *  - current is needs_review/approved (not yet filled), projection UNCHANGED → no-op: return the
   *    row untouched. A reprocess that yields byte-identical candidates must NOT reset an approved draft
   *    to needs_review, bump updated_at, or disturb an in-flight fill for that same content — doing
   *    so would withhold an otherwise-valid, already-approved fill until a re-approval that merely
   *    re-confirms identical data. Byte comparison is sound: `projected_json` was written via
   *    `JSON.stringify(mapping)` and renderForm projects the same candidates to the same key order, so
   *    identical content serializes identically.
   *  - current is needs_review/approved (not yet filled), projection CHANGED → overwrite its
   *    projection in place and reset to needs_review; new data invalidates any prior approval, so
   *    it re-reviews.
   */
  upsertProjection(customerId: string, formType: FormType, mapping: FormMapping, now: string): DraftRow {
    const cur = this.current(customerId, formType)
    if (!cur) return this.insert(customerId, formType, 1, mapping, now)
    if (cur.status === 'filled') return this.newRevision(customerId, formType, mapping, now)
    const projected = JSON.stringify(mapping)
    if (projected === cur.projected_json) return cur
    this.db.prepare('UPDATE form_drafts SET projected_json=?, status=?, approved_by=NULL, approved_at=NULL, updated_at=? WHERE id=?')
      .run(projected, 'needs_review', now, cur.id)
    return this.byId(cur.id)!
  }

  /**
   * Deviation from the brief's reference code (documented in task-12-report.md, per AGENTS.md
   * invariant #5 "every write path spanning >1 row is wrapped in a single transaction"): the
   * insert of the new revision and the supersede of the old row are two writes to form_drafts
   * that must commit or roll back together — otherwise a failure between them leaves a dangling
   * extra revision with no row marking it superseded (breaking the single-current invariant).
   * The brief's version ran these as two independent auto-commit statements.
   */
  newRevision(customerId: string, formType: FormType, mapping: FormMapping, now: string): DraftRow {
    const cur = this.current(customerId, formType)
    const next = this.maxRevision(customerId, formType) + 1
    const tx = this.db.transaction(() => {
      const row = this.insert(customerId, formType, next, mapping, now)
      if (cur) this.supersede(cur.id, next)
      return row
    })
    return tx()
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
