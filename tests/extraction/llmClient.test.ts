import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fixture from '../fixtures/llm/coastal_v1.json'
import { buildPrompt, MockLlmClient } from '../../src/extraction/llmClient.js'

describe('MockLlmClient', () => {
  it('returns a schema-validated envelope from the canned fixture, without any network call', async () => {
    const llm = new MockLlmClient(fixture)
    const env = await llm.extract('irrelevant transcript text')
    expect(env.annual_gross_revenue?.value).toBe(2500000)
  })

  it('rejects explicitly (does not swallow or crash) on a malformed canned envelope', async () => {
    // invariant #6 violation: presence 'present' with evidence null must fail schema validation.
    const malformed = { fein: { value: '12-3456789', presence: 'present', confidence: 0.9, evidence: null } }
    const llm = new MockLlmClient(malformed)
    await expect(llm.extract('irrelevant')).rejects.toThrow()
  })
})

describe('prompt injection', () => {
  it('builds the runtime prompt from an injected template with a transcript placeholder', () => {
    const prompt = buildPrompt('Prompt v7: {{transcript}}', 'insured owns a cafe')

    expect(prompt).toBe('Prompt v7: insured owns a cafe')
  })
})

describe('ai isolation boundary (AGENTS.md invariant #2)', () => {
  it('extractor.ts does not import the `ai` package', () => {
    const path = fileURLToPath(new URL('../../src/extraction/extractor.ts', import.meta.url))
    const src = readFileSync(path, 'utf8')
    expect(src).not.toMatch(/from ['"]ai['"]/)
  })

  it('llmClient.ts is the only production module importing `ai`, and uses Output.object (not the banned generateObject)', () => {
    const path = fileURLToPath(new URL('../../src/extraction/llmClient.ts', import.meta.url))
    const src = readFileSync(path, 'utf8')
    expect(src).toMatch(/from ['"]ai['"]/)
    expect(src).toMatch(/Output\.object/)
    expect(src).not.toMatch(/generateObject/)
  })
})
