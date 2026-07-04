import type { ExtractionEnvelope } from '../schema/profile'
import { CustomerIdentityRepo, IdentitySignalConflictError } from '../db/repos/customerIdentity'
import { identitySignalsFromEnvelope } from './identitySignals'

export interface ResolveCtx { sourceId: string; now: string; transcript: string }

/**
 * `customerId` is present only on the `resolved` branch. It is declared `undefined` (not
 * simply absent) on the `needs_review` branch so callers may read `result.customerId` without
 * a manual type guard first — TypeScript rejects a bare property read on a union unless every
 * member declares the property. Deviation from the brief's literal type (documented per task
 * instructions): the brief's two-armed union as written does not typecheck under this repo's
 * strict TS (`result.customerId` on a `CustomerResolution` errors with "Property 'customerId'
 * does not exist on type '{status: \"needs_review\"; reason: string}'"), and AGENTS.md invariant
 * #1 forbids `any`/`@ts-ignore` escape hatches to paper over it. Runtime behavior is unchanged:
 * `needs_review` results never set `customerId`.
 */
export type CustomerResolution =
  | { status: 'resolved'; customerId: string; reason: string }
  | { status: 'needs_review'; reason: string; customerId?: undefined }

const unique = <T>(items: T[]): T[] => [...new Set(items)]

export class CustomerResolver {
  constructor(private repo: CustomerIdentityRepo) {}

  resolve(env: ExtractionEnvelope, ctx: ResolveCtx): CustomerResolution {
    const signals = identitySignalsFromEnvelope(env, ctx.transcript)
    const hardSignals = signals.filter(s => s.strength === 'hard')
    const supportingSignals = signals.filter(s => s.strength === 'supporting')
    const matchedSignalsJson = JSON.stringify(signals)

    if (hardSignals.length === 0) {
      this.repo.insertResolution({
        sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
        reason: 'no_usable_hard_identity_signal', matchedSignalsJson, now: ctx.now,
      })
      return { status: 'needs_review', reason: 'no_usable_hard_identity_signal' }
    }

    const hardMatchedCustomerIds = unique(hardSignals.flatMap(s => this.repo.findCustomersBySignal(s.type, s.value)))
    const supportingMatchedCustomerIds = unique(supportingSignals.flatMap(s => this.repo.findCustomersBySignal(s.type, s.value)))
    const allMatchedCustomerIds = unique([...hardMatchedCustomerIds, ...supportingMatchedCustomerIds])

    // findCustomersBySignal searches every signal type. Supporting matches are safety evidence:
    // they can force needs_review when they disagree with a hard match, or when a new hard
    // identifier appears to belong to an existing customer by exact name/address. They never
    // auto-resolve a source by themselves.

    // Attach signals + record the 'resolved' verdict as ONE atomic unit (invariant #5): the
    // customer creation (when `create` is provided), every signal insert, and the resolution row
    // commit or roll back together, so a mid-write failure never leaves an orphaned customer or a
    // half-written identity. A hard-signal conflict (only reachable under a concurrent TOCTOU race,
    // since matches are pre-checked above) rolls the whole unit back, then records needs_review.
    const commitResolved = (
      existingCustomerId: string | null,
      create: (() => string) | null,
      resolvedReason: string,
    ): CustomerResolution => {
      try {
        const customerId = this.repo.transaction(() => {
          const id = create ? create() : existingCustomerId!
          for (const signal of signals) this.repo.insertSignal(id, signal, ctx.sourceId, ctx.now)
          this.repo.insertResolution({
            sourceId: ctx.sourceId, status: 'resolved', customerId: id,
            reason: resolvedReason, matchedSignalsJson, now: ctx.now,
          })
          return id
        })
        return { status: 'resolved', customerId, reason: resolvedReason }
      } catch (e) {
        if (!(e instanceof IdentitySignalConflictError)) throw e
        this.repo.insertResolution({
          sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
          reason: 'hard_identity_signal_conflict', matchedSignalsJson, now: ctx.now,
        })
        return { status: 'needs_review', reason: 'hard_identity_signal_conflict' }
      }
    }

    if (allMatchedCustomerIds.length > 1) {
      this.repo.insertResolution({
        sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
        reason: 'conflicting_identity_signals', matchedSignalsJson, now: ctx.now,
      })
      return { status: 'needs_review', reason: 'conflicting_identity_signals' }
    }

    if (hardMatchedCustomerIds.length === 1) {
      return commitResolved(hardMatchedCustomerIds[0]!, null, 'matched_hard_identity_signal')
    }

    if (supportingMatchedCustomerIds.length === 1) {
      this.repo.insertResolution({
        sourceId: ctx.sourceId, status: 'needs_review', customerId: null,
        reason: 'supporting_match_without_hard_match', matchedSignalsJson, now: ctx.now,
      })
      return { status: 'needs_review', reason: 'supporting_match_without_hard_match' }
    }

    const legalName = env.business_name?.presence === 'present' && typeof env.business_name.value === 'string'
      ? env.business_name.value
      : null
    const dba = env.dba_name?.presence === 'present' && typeof env.dba_name.value === 'string'
      ? env.dba_name.value
      : null
    // Only take a name part when the field is actually present — a needs_follow_up/not_applicable
    // field can still carry a non-null value, and that must not silently populate a new customer's
    // owner (this data is persisted, not just a test fixture).
    const ownerPart = (f: { value: string | null; presence: string } | undefined): string | null =>
      f?.presence === 'present' && typeof f.value === 'string' && f.value.length > 0 ? f.value : null
    const owner = [
      ownerPart(env.policyholder_first_name),
      ownerPart(env.policyholder_last_name),
    ].filter((v): v is string => v !== null).join(' ') || null

    return commitResolved(
      null,
      () => this.repo.createCustomer({ legalName, dba, owner, now: ctx.now }),
      'created_from_hard_identity_signal',
    )
  }
}
