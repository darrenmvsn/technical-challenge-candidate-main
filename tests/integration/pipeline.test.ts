import { describe, it, expect, beforeEach } from 'vitest'
import v1 from '../fixtures/llm/coastal_v1.json'
import v2 from '../fixtures/llm/coastal_v2.json'
import transcripts from '../fixtures/transcripts.json'
import { openDb, migrate, type DB } from '../../src/db/sqlite.js'
import { buildWebhookApp } from '../../src/ingest/webhook.js'
import { SourcesRepo } from '../../src/db/repos/sources.js'
import { ProcessingJobsRepo } from '../../src/db/repos/jobs.js'
import { FactsRepo } from '../../src/db/repos/facts.js'
import { ConflictsRepo } from '../../src/db/repos/conflicts.js'
import { CollectionItemsRepo } from '../../src/db/repos/collectionItems.js'
import { DraftsRepo } from '../../src/db/repos/drafts.js'
import { OutboxRepo } from '../../src/db/repos/outbox.js'
import { LeaseClaimer } from '../../src/lease/leaseClaimer.js'
import { MemoryBlobStore } from '../../src/blob/blobStore.js'
import { Processor } from '../../src/worker/processor.js'
import { OutboxWorker } from '../../src/worker/outboxWorker.js'
import { ReviewClient } from '../../src/review/reviewClient.js'
import { FixedClock } from '../../src/clock.js'
import type { LlmClient } from '../../src/extraction/llmClient.js'
import { ExtractionEnvelope } from '../../src/schema/profile.js'

/**
 * Test double that returns a DIFFERENT canned, schema-validated envelope on each call (by call
 * order), so the ORIGINAL transcript (src_001) and the CORRECTING transcript (src_002) extract
 * different facts within the same test run. Same contract as `MockLlmClient`
 * (`src/extraction/llmClient.ts`) — validates via `ExtractionEnvelope.parse` before returning,
 * never a network call — it just serves a queue of fixtures instead of one fixed fixture. This
 * is the ONLY LlmClient implementation in this file; nothing here imports `ai` (AGENTS.md #2).
 */
class RoutingLlm implements LlmClient {
  private i = 0
  constructor(private envs: unknown[]) {}
  async extract(): Promise<ExtractionEnvelope> {
    return ExtractionEnvelope.parse(this.envs[this.i++] ?? {})
  }
}

describe('end-to-end pipeline: ingest -> extract -> review -> approve -> fill, then a correction', () => {
  let db: DB
  const clock = new FixedClock('2025-03-12T10:31:00Z')
  const formTypes = ['acord_125'] as const

  beforeEach(() => {
    clock.set('2025-03-12T10:31:00Z')
    db = openDb()
    migrate(db)
  })

  function processor(llm: LlmClient) {
    return new Processor({
      db, sources: new SourcesRepo(db), jobs: new ProcessingJobsRepo(db), facts: new FactsRepo(db),
      conflicts: new ConflictsRepo(db), items: new CollectionItemsRepo(db), drafts: new DraftsRepo(db),
      lease: new LeaseClaimer(db, 'processing_jobs'), llm, clock, workerId: 'w', formTypes: [...formTypes],
    })
  }

  it('drives the REAL pipeline (webhook -> processor -> reviewClient -> outboxWorker) end to end, then a correcting transcript raises an approval-gated conflict and is re-approved + re-filled with no duplicate fill and an immutable first fill', async () => {
    const app = buildWebhookApp({ db, clock, wake: () => {} })
    const llm = new RoutingLlm([v1, v2])
    // The real provided call transcript (tests/fixtures/transcripts.json) — using its full
    // content (rather than a stub sentence) means locateEvidence resolves REAL spans/match
    // quality for coastal_v1's evidence quotes against genuine transcript text.
    const src001 = (transcripts as { id: string; date: string; content: string }[]).find(t => t.id === 'src_001')!

    const facts = new FactsRepo(db)
    const drafts = new DraftsRepo(db)
    const outbox = new OutboxRepo(db)
    const conflicts = new ConflictsRepo(db)
    const blob = new MemoryBlobStore()
    const rc = new ReviewClient({ db, facts, drafts, outbox, conflicts, clock, formTypes: [...formTypes], onEnqueued: () => {} })
    const worker = new OutboxWorker({ db, outbox, drafts, blob, lease: new LeaseClaimer(db, 'outbox'), clock, workerId: 'f' })

    // ==== 1. First transcript ingested through the REAL webhook route (validated, durable). ====
    const res1 = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { customer_id: 'c1', source: { id: src001.id, type: 'call_transcript', date: src001.date, content: src001.content } },
    })
    expect(res1.statusCode).toBe(202)
    expect(await processor(llm).drainOnce()).toBe(1)

    const draftBefore = drafts.current('c1', 'acord_125')!
    expect(JSON.parse(draftBefore.projected_json).annual_gross_revenue).toBe(2500000)
    // Evidence really resolved against the real transcript text (not a stub sentence) —
    // proves the extraction step is genuinely wired to evidenceMatcher end to end.
    const revenueFact = facts.byField('c1', 'annual_gross_revenue')[0]!
    expect(revenueFact.match_quality).toBe('exact')
    expect(revenueFact.evidence_span_start).not.toBeNull()
    expect(src001.content.slice(revenueFact.evidence_span_start!, revenueFact.evidence_span_end!)).toBe(revenueFact.evidence_quote)

    // ==== 2. Human approves the form (revenue currently 2.5M). ====
    const approved = rc.approveForm('c1', 'acord_125', { by: 'sarah' })
    expect(facts.byField('c1', 'annual_gross_revenue').some(f => f.review_status === 'approved')).toBe(true)

    // ==== PROPERTY 1: transcript 1 is fully processed and FILLED — a blob exists at the ====
    // ==== content-addressed key pdf/{customerId}/{formType}/{contentHash}. ====
    expect(await worker.drainOnce()).toBe(1)
    const filledFirst = drafts.byId(approved.draftId)!
    expect(filledFirst.status).toBe('filled')
    expect(filledFirst.pdf_ref).toMatch(/^pdf\/c1\/acord_125\/[0-9a-f]+$/)
    const firstBlobBytes = await blob.get(filledFirst.pdf_ref!)
    expect(firstBlobBytes).not.toBeNull()
    const firstBlobJson = JSON.parse(firstBlobBytes!.toString('utf8')) as { mapping: Record<string, unknown> }
    expect(firstBlobJson.mapping.annual_gross_revenue).toBe(2500000) // the blob really holds the approved value

    // ==== 3. Correcting transcript arrives: revenue 2.5M -> 2.8M, payroll (unbound) -> 1.75M. ====
    // Synthetic follow-up call text (no second real transcript is provided in the repo). It
    // contains coastal_v2's two evidence quotes verbatim so locateEvidence resolves REAL spans.
    const res2Content = 'One correction from last time: revenue was actually 2.8 million, and payroll was 1,750,000.'
    clock.set('2025-03-16T09:00:00Z')
    const res2 = await app.inject({
      method: 'POST', url: '/webhook/transcript',
      payload: { customer_id: 'c1', source: { id: 'src_002', type: 'call_transcript', date: '2025-03-15T10:00:00Z', content: res2Content } },
    })
    expect(res2.statusCode).toBe(202)
    expect(await processor(llm).drainOnce()).toBe(1)

    // Evidence-genuineness for the CORRECTION transcript too (not just T1): both changed facts
    // from src_002 must resolve to a REAL evidence span, so a silent locateEvidence regression on
    // source 2 fails this acceptance gate. Both quotes appear verbatim in the synthetic
    // correction text, so the genuine expected quality is 'exact' (must NOT be 'none'/'ambiguous').
    const revenueV2 = facts.byField('c1', 'annual_gross_revenue').find(f => f.source_id === 'src_002')!
    expect(revenueV2.match_quality).toBe('exact')
    expect(revenueV2.evidence_span_start).not.toBeNull()
    expect(res2Content.slice(revenueV2.evidence_span_start!, revenueV2.evidence_span_end!)).toBe(revenueV2.evidence_quote)
    const payrollV2 = facts.byField('c1', 'annual_payroll').find(f => f.source_id === 'src_002')!
    expect(payrollV2.match_quality).toBe('exact')
    expect(payrollV2.evidence_span_start).not.toBeNull()
    expect(res2Content.slice(payrollV2.evidence_span_start!, payrollV2.evidence_span_end!)).toBe(payrollV2.evidence_quote)

    // ==== PROPERTY 4: the disagreement surfaces a CONFLICT row, approval-gated. ====
    // annual_gross_revenue's CURRENT fact was already approved (2.5M) when the newer,
    // disagreeing candidate (2.8M) arrived -> the reconciler does NOT silently overwrite it; it
    // opens an unresolved conflict against the approved fact instead.
    const openConflicts = rc.listUnresolvedConflicts('c1')
    expect(openConflicts).toHaveLength(1)
    const revenueConflict = openConflicts.find(c => c.field_path === 'annual_gross_revenue')
    expect(revenueConflict).toBeTruthy()
    expect(facts.get(revenueConflict!.current_fact_id)!.review_status).toBe('approved')
    expect(JSON.parse(facts.get(revenueConflict!.current_fact_id)!.value_json!)).toBe(2500000)
    expect(JSON.parse(facts.get(revenueConflict!.conflicting_fact_id)!.value_json!)).toBe(2800000)

    // Contrast case proving the gate is APPROVAL-gated, not "any two disagreeing facts conflict":
    // annual_payroll is extracted (needs_follow_up -> present) but is NOT bound to acord_125
    // (AGENTS.md scope guardrails), so approveForm never approved it. With nothing approved to
    // protect, the reconciler raises no conflict for it and the newer value simply becomes the
    // current fact via ordinary selectCurrentFact precedence.
    expect(openConflicts.some(c => c.field_path === 'annual_payroll')).toBe(false)
    const payrollCurrent = facts.currentMap('c1').get('annual_payroll')!
    expect(payrollCurrent.review_status).not.toBe('approved')
    expect(JSON.parse(payrollCurrent.value_json!)).toBe(1750000)

    // The re-projection does NOT silently adopt the disputed value: a NEW draft revision is
    // minted (because the old one is filled/immutable, see Property 5) but it still reflects the
    // approved 2.5M until a human resolves the conflict.
    const reprojected = drafts.current('c1', 'acord_125')!
    expect(reprojected.revision).toBe(2)
    expect(reprojected.status).toBe('needs_review')
    expect(JSON.parse(reprojected.projected_json).annual_gross_revenue).toBe(2500000)

    // ==== PROPERTY 5: the FIRST fill is immutable — untouched by the correction. ====
    const firstAfterCorrection = drafts.byId(approved.draftId)!
    expect(firstAfterCorrection.status).toBe('filled')
    expect(firstAfterCorrection.pdf_ref).toBe(filledFirst.pdf_ref)
    expect(firstAfterCorrection.projected_json).toBe(filledFirst.projected_json)
    expect(firstAfterCorrection.superseded_by_revision).toBe(2) // superseded, never destroyed/mutated
    expect(await blob.get(filledFirst.pdf_ref!)).toEqual(firstBlobBytes) // original blob bytes untouched

    // ==== 4. Reviewer accepts the correction: edits the CURRENT (approved) fact via ====
    // approveForm's edit path, then explicitly resolves the conflict. A disagreeing machine
    // fact never auto-overwrites an approved one — a human must act.
    const second = rc.approveForm('c1', 'acord_125', { edits: { annual_gross_revenue: 2800000 }, by: 'sarah' })
    rc.resolveConflict(revenueConflict!.id, 'sarah')
    expect(rc.listUnresolvedConflicts('c1')).toHaveLength(0)
    expect(second.revision).toBe(2)
    expect(second.draftId).toBe(reprojected.id) // same (still needs_review) row, reprojected in place

    // ==== PROPERTY 2 + PROPERTY 3: re-approved, re-filled, and NO duplicate fill. ====
    expect(await worker.drainOnce()).toBe(1)
    const filledSecond = drafts.byId(second.draftId)!
    expect(filledSecond.status).toBe('filled')
    expect(filledSecond.pdf_ref).toMatch(/^pdf\/c1\/acord_125\/[0-9a-f]+$/)
    expect(filledSecond.pdf_ref).not.toBe(filledFirst.pdf_ref) // different content -> different content-addressed key
    const secondBlobJson = JSON.parse((await blob.get(filledSecond.pdf_ref!))!.toString('utf8')) as { mapping: Record<string, unknown> }
    expect(secondBlobJson.mapping.annual_gross_revenue).toBe(2800000)

    // Exactly-once: draining again with nothing pending fills nothing further, the first blob is
    // still byte-identical to what it was originally (no double-fill, no overwrite of its key),
    // and the two fills occupy two DISTINCT content-addressed keys (no collision/duplication).
    expect(await worker.drainOnce()).toBe(0)
    expect(await blob.get(filledFirst.pdf_ref!)).toEqual(firstBlobBytes)
    expect(new Set([filledFirst.pdf_ref, filledSecond.pdf_ref]).size).toBe(2)

    const doneRows = (db.prepare(
      `SELECT COUNT(*) n FROM outbox WHERE customer_id='c1' AND form_type='acord_125' AND status='done'`,
    ).get() as { n: number }).n
    expect(doneRows).toBe(2) // exactly one done fill per approval — no duplicate/extra fill rows
  })
})
