import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { resolveItemId } from '../../src/profile/collectionIdentity.js'
import { FixedClock } from '../../src/clock.js'
import { itemIdFor } from '../../src/util/hash.js'

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

  it('is deterministic across separate repo instances (built on itemIdFor, not random)', () => {
    const a = resolveItemId(repo, clock, 'c1', 'claims', '2023|workers_comp')
    expect(a).toBe(itemIdFor('c1', 'claims', '2023|workers_comp'))
  })

  it('different customers/collections for the same natural key never collide', () => {
    const a = resolveItemId(repo, clock, 'c1', 'claims', 'k')
    const b = resolveItemId(repo, clock, 'c2', 'claims', 'k')
    const c = resolveItemId(repo, clock, 'c1', 'locations', 'k')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it('produces an id usable in a collection.{item_id}.field path, never a numeric array index', () => {
    const id = resolveItemId(repo, clock, 'c1', 'claims', '2023|workers_comp')
    const fieldPath = `claims.${id}.claim_amount`
    expect(fieldPath).not.toMatch(/claims\[\d+\]/)
    expect(fieldPath).toMatch(/^claims\.[0-9a-f]+\.claim_amount$/)
  })
})
