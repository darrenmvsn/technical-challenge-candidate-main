import type { FormType } from '../schema/profile'
import type { FillMapping } from '../schema/forms'
import type { BlobStore } from '../blob/blobStore'
import { contentHash } from '../util/hash'

/**
 * Stub for the real form-filling service. Receives the NESTED fill mapping (the README
 * `fill_form` contract shape, built via `toFillMapping`) — not the flat review mapping.
 * Produces "PDF bytes" (the JSON mapping) and stores them at a deterministic,
 * content-addressed key so retries are idempotent.
 *
 * `content_hash` is computed over `{ customerId, formType, mapping }` — the SAME formula
 * `approveForm` (Task 13) uses to compute the outbox row's `content_hash` before this stub
 * ever runs (see plan §Task 13: `contentHash({ customerId, formType, mapping: fillMapping })`).
 * Both call sites must agree so the value stored on the outbox row equals the content-addressed
 * blob key this stub derives — one hash identifies one fill.
 */
export async function fillForm(
  customerId: string, formType: FormType, mapping: FillMapping, blob: BlobStore,
): Promise<{ pdf_ref: string; content_hash: string }> {
  const hash = contentHash({ customerId, formType, mapping })
  const pdf_ref = `pdf/${customerId}/${formType}/${hash}`
  await blob.put(pdf_ref, Buffer.from(JSON.stringify({ formType, mapping }, null, 2)))
  return { pdf_ref, content_hash: hash }
}
