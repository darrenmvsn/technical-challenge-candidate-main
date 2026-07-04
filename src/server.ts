import { openDb, migrate } from './db/sqlite.js'
import { SystemClock } from './clock.js'
import { buildWebhookApp } from './ingest/webhook.js'
import { SourcesRepo } from './db/repos/sources.js'
import { ProcessingJobsRepo } from './db/repos/jobs.js'
import { FactsRepo } from './db/repos/facts.js'
import { ConflictsRepo } from './db/repos/conflicts.js'
import { CollectionItemsRepo } from './db/repos/collectionItems.js'
import { DraftsRepo } from './db/repos/drafts.js'
import { OutboxRepo } from './db/repos/outbox.js'
import { LeaseClaimer } from './lease/leaseClaimer.js'
import { MemoryBlobStore } from './blob/blobStore.js'
import { AiSdkLlmClient, MockLlmClient } from './extraction/llmClient.js'
import { Processor } from './worker/processor.js'
import { OutboxWorker } from './worker/outboxWorker.js'
import { ReviewClient } from './review/reviewClient.js'
import type { FormType } from './schema/profile.js'

// Composition root — no business logic here, only wiring the real dependency graph together (DI).

const clock = new SystemClock()
const db = openDb(process.env.DB_PATH ?? 'data/acord.db')
migrate(db)

const formTypes: FormType[] = ['acord_125', 'acord_126']
const blob = new MemoryBlobStore()
const llm = process.env.LLM_LIVE === '1' ? new AiSdkLlmClient() : new MockLlmClient({})

const processor = new Processor({
  db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
  conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
  lease: new LeaseClaimer(db, 'processing_jobs'), llm, clock, workerId: 'proc-1', formTypes,
})
const outboxWorker = new OutboxWorker({
  db, outbox: new OutboxRepo(db), drafts: new DraftsRepo(db), blob,
  lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'fill-1',
})

// The human-review surface. onEnqueued is the spec's PRIMARY wake-on-commit path: an approval
// nudges the fill worker immediately (the poll below is only the backstop). Not yet wired to an
// HTTP route (out of scope for this ticket — see file structure); exported for whatever review
// surface consumes it next.
export const reviewClient = new ReviewClient({
  db, facts: new FactsRepo(db), drafts: new DraftsRepo(db), outbox: new OutboxRepo(db),
  conflicts: new ConflictsRepo(db), clock, formTypes,
  onEnqueued: () => { void outboxWorker.drainOnce() },
})

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
 * state. Fixed by threading `idle` through the recursive call as a parameter instead of closing
 * over a shared outer variable, so each `loop()` invocation below owns an independent backoff
 * sequence.
 */
function loop(run: () => Promise<number>, idle: number, min = 1000, max = 30_000): void {
  void run().then(n => {
    const next = n > 0 ? min : Math.min(idle * 2, max)
    setTimeout(() => loop(run, next, min, max), next)
  })
}
loop(() => processor.drainOnce(), 1000)
loop(() => outboxWorker.drainOnce(), 1000)

const app = buildWebhookApp({ db, clock, wake: () => { void processor.drainOnce() } })
app.listen({ port: Number(process.env.PORT ?? 8080) })
  .then(() => console.log('webhook up'))
  .catch((err: unknown) => {
    // Production error posture: never swallow — an unhandled `listen()` rejection (e.g. the
    // port is already in use) must be visible and must fail the process, not vanish into an
    // unhandled-rejection warning.
    console.error('failed to start webhook server:', err)
    process.exitCode = 1
  })
