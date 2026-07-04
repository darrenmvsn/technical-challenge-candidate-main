import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DB } from '../db/sqlite.js'
import type { Clock } from '../clock.js'
import { SourcesRepo, insertSourceAndJob } from '../db/repos/sources.js'
import { contentHash } from '../util/hash.js'
import { newId } from '../util/id.js'

export interface WebhookDeps { db: DB; clock: Clock; wake: () => void }

/**
 * AGENTS.md invariant #10: the webhook boundary validates BEFORE any DB write. No raw
 * `req.body as X` trust-boundary cast anywhere in the handler — `safeParse` below is the only
 * way the untyped Fastify body becomes a typed value.
 */
const TranscriptWebhookBody = z.object({
  customer_id: z.string().min(1),
  source: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    date: z.string().min(1),
    content: z.string().min(1),
  }),
})

/**
 * Deviation from the brief's literal reference code (documented per task instructions, watching
 * for "validation after a write" / "a check-then-insert dedupe race" per the dispatch note):
 *
 * 1. The reference handler validated with an ad hoc `if (!b?.customer_id || !b?.source?.content)`
 *    guard applied AFTER `const b = req.body as {...}` — a raw trust-boundary cast (AGENTS.md
 *    #10 explicitly bans this) that also only spot-checks two fields, silently accepting e.g. a
 *    non-string `source.id` or a missing `source.type`/`date`. Replaced with a Zod schema
 *    (`safeParse`) that runs first and rejects anything that doesn't match the full shape,
 *    with no cast at all — `parsed.data` is a real typed value.
 *
 * 2. The reference handler's own `existsById`/`existsByChecksum` pre-check, followed
 *    unconditionally by `insertSourceAndJob` + a `202 { job_id: jobId }` reply, is a
 *    check-THEN-insert race: two concurrent requests for the same new source can both pass the
 *    pre-check before either commits. `insertSourceAndJob`'s in-transaction dedupe (Task 15)
 *    prevents a double INSERT, but the reference code still blindly replies `202` with a
 *    `job_id` regardless of whether ITS call actually inserted anything — the race's loser
 *    would get back a 202 referencing a job row that was never created (a lying response, and
 *    `wake()` would nudge the processor for a job that doesn't exist). The fix reads the
 *    `{ inserted }` result `insertSourceAndJob` now returns and only replies `202`/wakes the
 *    processor when THIS call actually performed the insert; otherwise it replies with the same
 *    deduped `200` as the pre-check path. The pre-check is kept as a fast path (avoids building
 *    the checksum/job row for the common sequential-redelivery case) but is no longer the source
 *    of truth for the response — `insertSourceAndJob`'s atomic result is.
 */
export function buildWebhookApp(deps: WebhookDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const sources = new SourcesRepo(deps.db)

  app.post('/webhook/transcript', async (req, reply) => {
    const parsed = TranscriptWebhookBody.safeParse(req.body)
    if (!parsed.success) {
      // Production error posture: no stack trace, no raw Zod issue dump — a plain 400.
      return reply.code(400).send({ error: 'invalid payload' })
    }
    const b = parsed.data

    // Checksum is a hash of CONTENT identity (customer + transcript content), deliberately
    // EXCLUDING `source.id`. Task 15's SourcesRepo doc comment describes the intended purpose
    // of `existsByChecksum` as catching "a webhook redelivery that mints new ids" — i.e. the
    // same transcript content redelivered under a fresh provider-assigned id. The brief's
    // literal reference code computed the checksum AS `contentHash({ customer_id, id:
    // b.source.id, content })`, folding the (deliberately variable) source id into the hash.
    // That makes every redelivery's checksum unique whenever the id changes, silently defeating
    // the entire id-less-redelivery dedup path `existsByChecksum` exists for — two requests with
    // byte-identical content but different ids would never collide, and BOTH would create a
    // real source+job row (a duplicate ingest for the same content). Fixed by hashing only
    // customer_id + content, so byte-identical content redelivered under any id dedupes.
    const checksum = contentHash({ customer_id: b.customer_id, content: b.source.content })

    // Fast path only — NOT the dedupe source of truth (see deviation note above).
    if (sources.existsById(b.source.id) || sources.existsByChecksum(checksum)) {
      return reply.code(200).send({ deduped: true })
    }

    const now = deps.clock.now()
    const jobId = newId()
    const { inserted } = insertSourceAndJob(deps.db, {
      source: {
        id: b.source.id, customer_id: b.customer_id, type: b.source.type, source_date: b.source.date,
        received_at: now, raw_json: JSON.stringify({ content: b.source.content }), checksum,
      },
      job: { id: jobId, source_id: b.source.id, customer_id: b.customer_id, next_attempt_at: now, created_at: now },
    })

    if (!inserted) {
      // Lost the race between our pre-check and the atomic insert above — a concurrent request
      // beat us to it. Reply exactly as the pre-check path would; do NOT claim a job_id that was
      // never written, and do NOT wake the processor for a job that doesn't exist.
      return reply.code(200).send({ deduped: true })
    }

    deps.wake() // nudge the processor (best-effort; polling backstop covers misses)
    return reply.code(202).send({ job_id: jobId })
  })

  return app
}
