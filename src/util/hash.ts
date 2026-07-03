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
