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
export type PromptProvider = () => string | Promise<string>

const TRANSCRIPT_PLACEHOLDER = '{{transcript}}'

const DEFAULT_PROMPT_TEMPLATE =
  `Extract the business insurance facts from this call transcript. For every field set ` +
  `presence to present/missing/needs_follow_up/not_applicable, give a 0..1 confidence, and ` +
  `quote the verbatim supporting text in "evidence" (null when missing). Do not guess.\n\n${TRANSCRIPT_PLACEHOLDER}`

export const buildPrompt = (template: string, transcript: string) =>
  template.includes(TRANSCRIPT_PLACEHOLDER)
    ? template.replaceAll(TRANSCRIPT_PLACEHOLDER, transcript)
    : `${template}\n\n${transcript}`

/** Real provider via the current AI SDK v6 structured-output API, with bounded retries. */
export class AiSdkLlmClient implements LlmClient {
  constructor(
    private model = openai('gpt-5.2'),
    private maxRetries = 2,
    private promptProvider: PromptProvider = () => DEFAULT_PROMPT_TEMPLATE,
  ) {}
  async extract(transcript: string): Promise<ExtractionEnvelope> {
    let lastErr: unknown
    const promptTemplate = await this.promptProvider()
    const prompt = buildPrompt(promptTemplate, transcript)
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { output } = await generateText({
          model: this.model,
          output: Output.object({ schema: ExtractionEnvelope }),
          prompt,
        })
        return output
      } catch (e) { lastErr = e }
    }
    // Bounded retries exhausted — surface the last failure explicitly rather than returning
    // an empty/undefined envelope (production error posture: no silent swallow).
    throw lastErr
  }
}
