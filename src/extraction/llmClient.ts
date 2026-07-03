import { generateText, Output } from 'ai'
import { openai } from '@ai-sdk/openai'
import { ExtractionEnvelope } from '../schema/profile.js'

// AGENTS.md invariant #2: this is the ONLY module allowed to import `ai`. All LLM access
// elsewhere in the pipeline goes through the `LlmClient` interface below.
export interface LlmClient { extract(transcript: string): Promise<ExtractionEnvelope> }

/** Deterministic test double — returns a canned, schema-validated envelope. No network I/O. */
export class MockLlmClient implements LlmClient {
  constructor(private canned: unknown) {}
  async extract(_transcript: string): Promise<ExtractionEnvelope> {
    // Schema validation is the explicit failure mode for a malformed canned fixture — it
    // throws (production error posture: never swallowed), which is exactly what a real
    // provider returning a schema-violating payload would also do downstream.
    return ExtractionEnvelope.parse(this.canned)
  }
}

const PROMPT = (t: string) =>
  `Extract the business insurance facts from this call transcript. For every field set ` +
  `presence to present/missing/needs_follow_up/not_applicable, give a 0..1 confidence, and ` +
  `quote the verbatim supporting text in "evidence" (null when missing). Do not guess.\n\n${t}`

/** Real provider via the current AI SDK v6 structured-output API, with bounded retries. */
export class AiSdkLlmClient implements LlmClient {
  constructor(private model = openai('gpt-5.2'), private maxRetries = 2) {}
  async extract(transcript: string): Promise<ExtractionEnvelope> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { output } = await generateText({
          model: this.model,
          output: Output.object({ schema: ExtractionEnvelope }),
          prompt: PROMPT(transcript),
        })
        return output
      } catch (e) { lastErr = e }
    }
    // Bounded retries exhausted — surface the last failure explicitly rather than returning
    // an empty/undefined envelope (production error posture: no silent swallow).
    throw lastErr
  }
}
