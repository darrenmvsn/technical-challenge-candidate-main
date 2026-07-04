import type { Clock } from '../clock'
import type { SourcesRepo } from '../db/repos/sources'
import type { ProcessingJobsRepo } from '../db/repos/jobs'
import { CustomerIdentityRepo, IdentitySignalConflictError } from '../db/repos/customerIdentity'
import { identitySignalsFromEnvelope } from '../identity/identitySignals'
import { ExtractionEnvelope } from '../schema/profile'
import { newId } from '../util/id'

export interface IdentityReviewDeps {
  sources: SourcesRepo
  jobs: ProcessingJobsRepo
  identity: CustomerIdentityRepo
  clock: Clock
}

export interface IdentityReviewOpts { by: string }

export type IdentityReviewResolution =
  | { status: 'resolved'; jobId: string }
  | { status: 'needs_review'; reason: 'hard_identity_signal_conflict' | 'customer_not_found' | 'source_already_resolved' }

interface RawSourcePayload { content: string }

class SourceAlreadyResolvedError extends Error {}

/**
 * Human one-click "attach this ambiguous source to that customer" path. A source parked by
 * the processor at `identity_needs_review` (no/ambiguous hard identity signal) is attached to
 * a reviewer-chosen customer: the source's verified identity signals are TAUGHT to that
 * customer (so future sources carrying the same fein/email auto-resolve), the source is
 * attached and flipped to `resolved`, and a fresh `processing_jobs` row is enqueued so the
 * processor reprocesses it — reusing the already-stored `extraction_json`, never a second LLM
 * call (the processor's `source.customer_id != null` branch skips `CustomerResolver` entirely
 * and persists straight under the attached customer).
 *
 * Mirrors `CustomerResolver`'s atomic-with-conflict-rollback pattern (AGENTS.md invariant #5):
 * every verified signal insert, the source attach, the resolution row, and the new job insert
 * commit or roll back TOGETHER inside `identity.transaction(...)`. If the chosen customer's
 * signals collide with a HARD signal (fein/email) that already belongs to a DIFFERENT
 * customer, `insertSignal` throws `IdentitySignalConflictError`, the whole unit rolls back
 * (no partial signal writes, no attach, no job), and a single `needs_review` resolution row is
 * recorded afterward — the source is left exactly as it was (still `identity_needs_review`,
 * `customer_id` still NULL).
 */
export class IdentityReviewClient {
  constructor(private d: IdentityReviewDeps) {}

  resolveSourceToCustomer(sourceId: string, customerId: string, opts: IdentityReviewOpts): IdentityReviewResolution {
    const { sources, jobs, identity, clock } = this.d

    const source = sources.get(sourceId)
    if (!source || source.status !== 'identity_needs_review') {
      throw new Error(`source ${sourceId} is not awaiting identity review`)
    }
    if (source.extraction_json == null) {
      throw new Error(`source ${sourceId} has no stored extraction to reuse`)
    }

    const now = clock.now()
    const env = ExtractionEnvelope.parse(JSON.parse(source.extraction_json))
    const { content: transcript } = JSON.parse(source.raw_json) as RawSourcePayload
    const signals = identitySignalsFromEnvelope(env, transcript)
    const matchedSignalsJson = JSON.stringify(signals)

    try {
      return identity.transaction(() => {
        if (!identity.customerExists(customerId)) {
          identity.insertResolution({
            sourceId, status: 'needs_review', customerId: null, reason: 'customer_not_found',
            matchedSignalsJson, now, resolvedBy: opts.by, resolvedAt: now,
          })
          return { status: 'needs_review', reason: 'customer_not_found' }
        }
        for (const signal of signals) identity.insertSignal(customerId, signal, sourceId, now)
        if (!sources.attachCustomerForIdentityReview(sourceId, customerId, now)) {
          throw new SourceAlreadyResolvedError()
        }
        identity.insertResolution({
          sourceId, status: 'resolved', customerId, reason: 'manual_identity_review',
          matchedSignalsJson, now, resolvedBy: opts.by, resolvedAt: now,
        })
        const jid = newId()
        jobs.insert({ id: jid, source_id: sourceId, next_attempt_at: now, created_at: now })
        return { status: 'resolved', jobId: jid }
      })
    } catch (e) {
      if (e instanceof SourceAlreadyResolvedError) {
        return { status: 'needs_review', reason: 'source_already_resolved' }
      }
      if (!(e instanceof IdentitySignalConflictError)) throw e
      // The transaction rolled back above: no signals, no attach, no job. Record the
      // conflict verdict as a single-row write, after rollback, so it isn't itself undone.
      identity.insertResolution({
        sourceId, status: 'needs_review', customerId: null, reason: 'hard_identity_signal_conflict',
        matchedSignalsJson, now, resolvedBy: opts.by, resolvedAt: now,
      })
      return { status: 'needs_review', reason: 'hard_identity_signal_conflict' }
    }
  }
}
