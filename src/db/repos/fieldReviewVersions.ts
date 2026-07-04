import type { DB } from '../sqlite'
import type { FieldReviewVersion, Presence, ReviewAction } from '../../schema/profile'
import { newId } from '../../util/id'

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
    this.assertCandidateMatches(args.customerId, args.fieldPath, args.candidateId)
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

  private assertCandidateMatches(customerId: string, fieldPath: string, candidateId: string): void {
    const row = this.db.prepare(`SELECT customer_id, field_path
      FROM extracted_field_candidates WHERE id=?`).get(candidateId) as
      | { customer_id: string; field_path: string }
      | undefined
    if (!row || row.customer_id !== customerId || row.field_path !== fieldPath) {
      throw new Error(`review candidate ${candidateId} does not belong to ${customerId}/${fieldPath}`)
    }
  }
}
