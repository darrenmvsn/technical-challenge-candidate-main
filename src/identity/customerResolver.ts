import type { ExtractionEnvelope } from '../schema/profile.js'
import { CustomerIdentityRepo, IdentitySignalConflictError } from '../db/repos/customerIdentity.js'
import { identitySignalsFromEnvelope } from './identitySignals.js'

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

    const insertSignalsOrNeedsReview = (customerId: string): CustomerResolution | undefined => {
      try {
        for (const signal of signals) this.repo.insertSignal(customerId, signal, ctx.sourceId, ctx.now)
        return undefined
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
      const customerId = hardMatchedCustomerIds[0]!
      const conflict = insertSignalsOrNeedsReview(customerId)
      if (conflict) return conflict
      this.repo.insertResolution({
        sourceId: ctx.sourceId, status: 'resolved', customerId,
        reason: 'matched_hard_identity_signal', matchedSignalsJson, now: ctx.now,
      })
      return { status: 'resolved', customerId, reason: 'matched_hard_identity_signal' }
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
    const owner = [
      env.policyholder_first_name?.value,
      env.policyholder_last_name?.value,
    ].filter(v => typeof v === 'string' && v.length > 0).join(' ') || null

    const customerId = this.repo.createCustomer({ legalName, dba, owner, now: ctx.now })
    const conflict = insertSignalsOrNeedsReview(customerId)
    if (conflict) return conflict
    this.repo.insertResolution({
      sourceId: ctx.sourceId, status: 'resolved', customerId,
      reason: 'created_from_hard_identity_signal', matchedSignalsJson, now: ctx.now,
    })
    return { status: 'resolved', customerId, reason: 'created_from_hard_identity_signal' }
  }
}
