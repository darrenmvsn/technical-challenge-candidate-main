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
 *
 * The payload is now the RAW transcript object (no `customer_id` — identity is resolved later,
 * by the processor, from the transcript content). `date` is still validated as a real ISO-8601
 * UTC timestamp: it is persisted as `source_date` and drives lexicographic candidate selection
 * (selectCurrentCandidate), so a malformed value ("zzzz") must never reach the DB and sort above real
 * dates. `participants` is captured verbatim in `raw_json` for provenance.
 */
const RawTranscript = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  date: z.string().datetime({ message: 'date must be ISO-8601 UTC' }),
  participants: z.array(z.string()).min(1),
  content: z.string().min(1),
})

/**
 * The dedupe design (unchanged in intent from the previous contract): `insertSourceAndJob`
 * performs an atomic in-transaction check+insert and returns `{ inserted }`. The handler's own
 * `existsById`/`existsByChecksum` pre-check is a fast path only for the common
 * sequential-redelivery case — NOT the dedupe source of truth. Under concurrent requests for the
 * same new source, both can pass the pre-check before either commits; the loser gets
 * `inserted === false` from the atomic insert and replies with the same deduped `200` as the
 * pre-check path, never a `202` claiming a `job_id` that was never written, and never `wake()`s
 * the processor for a job that does not exist.
 *
 * `checksum` hashes CONTENT identity (type + date + content), deliberately EXCLUDING `id`, so a
 * redelivery that mints a fresh provider id but carries byte-identical content still dedupes via
 * `existsByChecksum`.
 */
export function buildWebhookApp(deps: WebhookDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const sources = new SourcesRepo(deps.db)

  app.post('/webhook/transcript', async (req, reply) => {
    const parsed = RawTranscript.safeParse(req.body)
    if (!parsed.success) {
      // Production error posture: no stack trace, no raw Zod issue dump — a plain 400.
      return reply.code(400).send({ error: 'invalid payload' })
    }
    const b = parsed.data

    const checksum = contentHash({ type: b.type, date: b.date, content: b.content })

    // Fast path only — NOT the dedupe source of truth (see doc comment above).
    if (sources.existsById(b.id) || sources.existsByChecksum(checksum)) {
      return reply.code(200).send({ deduped: true })
    }

    const now = deps.clock.now()
    const jobId = newId()
    const { inserted } = insertSourceAndJob(deps.db, {
      source: {
        id: b.id, customer_id: null, type: b.type, source_date: b.date,
        received_at: now, raw_json: JSON.stringify(b), checksum,
      },
      job: { id: jobId, source_id: b.id, next_attempt_at: now, created_at: now },
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
