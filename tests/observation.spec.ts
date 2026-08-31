import { describe, expect, it } from 'vitest'
import { markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseConfig } from '../src/config.js'
import { HealthBook } from '../src/health.js'
import { createRouterRuntime } from '../src/runtime/router.js'
import type { CandidateModel } from '../src/types.js'

const candidate: CandidateModel = {
  provider: 'openrouter', model: 'model:free', displayName: 'Model', contextWindow: 65_536,
  toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 0,
}

const options = (): GenerateOptions => markAgentLoopRequest({
  provider: candidate.provider,
  model: candidate.model,
  messages: [],
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('RouterRuntime stream observation', () => {
  it('records first-chunk latency for a successful main-agent request', async () => {
    let now = 0
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}), getCandidates: () => [candidate], health, now: () => now,
    })
    async function* success(): AsyncIterable<StreamChunk> {
      now = 145
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    const chunks = await collect(runtime.observeStream(options(), () => success()))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(health.snapshot('openrouter/model:free', now).averageFirstByteMs).toBe(145)
  })

  it('records a normalized failure but leaves non-agent and auxiliary calls unmeasured', async () => {
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}), getCandidates: () => [candidate], health, now: () => 1_000,
    })
    async function* failed(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'bad' } } }
    }
    await collect(runtime.observeStream(options(), () => failed()))
    expect(health.isCooling('openrouter/model:free', 1_000)).toBe(true)

    const nonAgent: GenerateOptions = { provider: candidate.provider, model: candidate.model, messages: [] }
    await collect(runtime.observeStream(nonAgent, () => failed()))
    await collect(runtime.observeStream({ ...options(), purpose: 'session-title' }, () => failed()))
    expect(health.snapshot('openrouter/model:free', 1_000).consecutiveFailures).toBe(1)
  })
})
