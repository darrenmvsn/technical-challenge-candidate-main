import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, migrate } from './db/sqlite'
import type { DB } from './db/sqlite'
import { SystemClock } from './clock'
import { buildWebhookApp } from './ingest/webhook'
import { SourcesRepo } from './db/repos/sources'
import { ProcessingJobsRepo } from './db/repos/jobs'
import { ExtractedFieldCandidatesRepo } from './db/repos/extractedFieldCandidates'
import { FieldReviewVersionsRepo } from './db/repos/fieldReviewVersions'
import { FieldConflictsRepo } from './db/repos/fieldConflicts'
import { CollectionItemsRepo } from './db/repos/collectionItems'
import { DraftsRepo } from './db/repos/drafts'
import { OutboxRepo } from './db/repos/outbox'
import { CustomerIdentityRepo } from './db/repos/customerIdentity'
import { CustomerResolver } from './identity/customerResolver'
import { LeaseClaimer } from './lease/leaseClaimer'
import { LocalBlobStore } from './blob/blobStore'
import { AiSdkLlmClient, MockLlmClient } from './extraction/llmClient'
import { Processor } from './worker/processor'
import { OutboxWorker } from './worker/outboxWorker'
import { ReviewClient } from './review/reviewClient'
import type { FormType } from './schema/profile'

// Composition root — no business logic here, only wiring the real dependency graph together (DI).

export interface AdaptiveLoopOptions {
  initialMs?: number
  minMs?: number
  maxMs?: number
  setTimeout?: (cb: () => void, ms: number) => unknown
  onError?: (err: unknown) => void
}

export interface ServerRuntime {
  db: DB
  processor: Processor
  outboxWorker: OutboxWorker
  reviewClient: ReviewClient
  app: ReturnType<typeof buildWebhookApp>
}

export let reviewClient: ReviewClient | undefined

export function fireAndReport(run: () => Promise<unknown>, onError = defaultBackgroundError): void {
  void run().catch(onError)
}

export function startAdaptiveLoop(run: () => Promise<number>, opts: AdaptiveLoopOptions = {}): void {
  const min = opts.minMs ?? 1000
  const max = opts.maxMs ?? 30_000
  const scheduler = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const onError = opts.onError ?? defaultBackgroundError
  const startMs = opts.initialMs ?? min

  const tick = (idle: number): void => {
    void run()
      .then(n => {
        const next = n > 0 ? min : Math.min(idle * 2, max)
        scheduler(() => { tick(next) }, next)
      })
      .catch(err => {
        onError(err)
        const next = Math.min(idle * 2, max)
        scheduler(() => { tick(next) }, next)
      })
  }

  tick(startMs)
}

/**
 * Adaptive backstop poll (wake-on-commit calls drainOnce directly elsewhere).
 *
 * Deviation from the brief's literal reference code (documented per task instructions): the
 * reference implementation kept a single module-level `let idle = 1000` shared across BOTH
 * `loop()` call chains below (one polling `processor.drainOnce`, one polling
 * `outboxWorker.drainOnce`). Because both recursive chains read AND wrote that same shared
 * variable, each loop's backoff schedule leaked into the other's: e.g. the processor loop
 * finding work and resetting `idle` to `min` would also shrink the outbox loop's next
 * `setTimeout` delay even though the outbox queue was empty and had legitimately backed off,
 * and vice versa — two independent queues silently coupled through one shared piece of mutable
 * state. `startAdaptiveLoop()` threads `idle` through each recursive call, so each invocation
 * owns an independent backoff sequence. It also catches rejected drains and schedules the next
 * poll, so one transient worker error cannot permanently stop a queue.
 */
export function startServer(env: NodeJS.ProcessEnv = process.env): ServerRuntime {
  const clock = new SystemClock()
  const db = openDb(env.DB_PATH ?? 'data/acord.db')
  migrate(db)

  const formTypes: FormType[] = ['acord_125', 'acord_126']
  const blob = new LocalBlobStore(env.BLOB_PATH ?? 'data/blob')
  const llm = env.LLM_LIVE === '1' ? new AiSdkLlmClient() : new MockLlmClient({})

  const identity = new CustomerIdentityRepo(db)
  const resolver = new CustomerResolver(identity)
  const processor = new Processor({
    db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), candidates: new ExtractedFieldCandidatesRepo(db),
    reviewVersions: new FieldReviewVersionsRepo(db), conflicts: new FieldConflictsRepo(db),
    items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
    outbox: new OutboxRepo(db), lease: new LeaseClaimer(db, 'processing_jobs'), llm, resolver, clock, workerId: 'proc-1', formTypes,
  })
  const outboxWorker = new OutboxWorker({
    db, outbox: new OutboxRepo(db), drafts: new DraftsRepo(db), blob,
    lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'fill-1',
  })

  // The human-review surface. onEnqueued is the spec's PRIMARY wake-on-commit path: an approval
  // nudges the fill worker immediately (the poll below is only the backstop). Not yet wired to an
  // HTTP route (out of scope for this ticket — see file structure); exported for whatever review
  // surface consumes it next.
  reviewClient = new ReviewClient({
    db, candidates: new ExtractedFieldCandidatesRepo(db), reviewVersions: new FieldReviewVersionsRepo(db),
    drafts: new DraftsRepo(db), outbox: new OutboxRepo(db),
    conflicts: new FieldConflictsRepo(db), clock, formTypes,
    onEnqueued: () => {
      fireAndReport(() => outboxWorker.drainOnce(), err => { console.error('outbox wake failed:', err) })
    },
  })

  startAdaptiveLoop(() => processor.drainOnce(), {
    onError: err => { console.error('processor poll failed:', err) },
  })
  startAdaptiveLoop(() => outboxWorker.drainOnce(), {
    onError: err => { console.error('outbox poll failed:', err) },
  })

  const app = buildWebhookApp({
    db,
    clock,
    wake: () => {
      fireAndReport(() => processor.drainOnce(), err => { console.error('processor wake failed:', err) })
    },
  })

  fireAndReport(
    async () => {
      await app.listen({ port: Number(env.PORT ?? 8080) })
      console.log('webhook up')
    },
    err => {
      // Production error posture: never swallow — an unhandled `listen()` rejection (e.g. the
      // port is already in use) must be visible and must fail the process, not vanish into an
      // unhandled-rejection warning.
      console.error('failed to start webhook server:', err)
      process.exitCode = 1
    },
  )

  return { db, processor, outboxWorker, reviewClient, app }
}

function defaultBackgroundError(err: unknown): void {
  console.error('background task failed:', err)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectRun()) startServer()
