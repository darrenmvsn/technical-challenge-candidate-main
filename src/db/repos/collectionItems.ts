import type { DB } from '../sqlite'

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
