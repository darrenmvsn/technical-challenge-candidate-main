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
