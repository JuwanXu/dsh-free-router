import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { parseConfig } from '../src/config.js'
import { HealthBook } from '../src/health.js'
import { createRouterRuntime } from '../src/runtime/router.js'
import type { CandidateModel } from '../src/types.js'

const signal = new AbortController().signal
const original: LlmCallConfig = { provider: 'openrouter', model: 'user-selected', reasoningEffort: ReasoningEffortId('high') }

function candidate(provider: string, model: string, tier: string = 'A'): CandidateModel {
  return {
    provider,
    model,
    displayName: model,
    contextWindow: 65_536,
    toolCalling: true,
    free: true,
    tier,
    catalogUpdatedAt: 0,
  }
}

function request(agent: object, turn = 1, step = 1) {
  return { agent, turn, step, signal }
}

describe('RouterRuntime', () => {
  it('selects the best eligible model and removes source-model reasoning effort', async () => {
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate('openrouter', 'good-model', 'A'), candidate('nvidia', 'best-model', 'S')],
      health,
      now: () => 1_000,
    })

    await expect(runtime.onRequest(request({}), async () => original)).resolves.toEqual({
      provider: 'nvidia',
      model: 'best-model',
    })
  })

  it('retries another model after a transient failure and cools the failed model', async () => {
    const agent = {}
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate('nvidia', 'best-model', 'S'), candidate('openrouter', 'fallback', 'A')],
      health,
      now: () => 1_000,
    })
    await runtime.onRequest(request(agent), async () => original)

    await expect(runtime.onRequestError({
      ...request(agent),
      provider: 'nvidia',
      failure: { code: 'RATE_LIMIT', message: 'slow down' },
      retryPolicy: undefined,
    }, async () => undefined)).resolves.toEqual({ kind: 'retry' })
    expect(health.isCooling('nvidia/best-model', 1_000)).toBe(true)
  })

  it('delegates unsupported options without recording a retry', async () => {
    const agent = {}
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate('nvidia', 'best-model', 'S'), candidate('openrouter', 'fallback', 'A')],
      health,
      now: () => 1_000,
    })
    await runtime.onRequest(request(agent), async () => original)
    const downstream = async () => ({ kind: 'retry' } as const)

    await expect(runtime.onRequestError({
      ...request(agent),
      provider: 'nvidia',
      failure: { code: 'UNSUPPORTED_OPTION', message: 'nope' },
      retryPolicy: undefined,
    }, downstream)).resolves.toEqual({ kind: 'retry' })
    expect(health.snapshot('nvidia/best-model', 1_000).consecutiveFailures).toBe(0)
  })

  it('returns the original config without eligible candidates', async () => {
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ providers: { nvidia: { enabled: false } } }),
      getCandidates: () => [candidate('nvidia', 'best-model', 'S')],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      now: () => 1_000,
    })

    await expect(runtime.onRequest(request({}), async () => original)).resolves.toEqual(original)
  })

  it('does not retry after all candidates for a step were exhausted', async () => {
    const agent = {}
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ routing: { maxAttemptsPerStep: 2 } }),
      getCandidates: () => [candidate('nvidia', 'best-model', 'S'), candidate('openrouter', 'fallback', 'A')],
      health,
      now: () => 1_000,
    })
    const downstream = async () => undefined
    await runtime.onRequest(request(agent), async () => original)
    await runtime.onRequestError({ ...request(agent), provider: 'nvidia', failure: { code: 'SERVER', message: 'bad' }, retryPolicy: undefined }, downstream)
    await runtime.onRequest(request(agent), async () => original)

    await expect(runtime.onRequestError({
      ...request(agent),
      provider: 'openrouter',
      failure: { code: 'SERVER', message: 'bad' },
      retryPolicy: undefined,
    }, downstream)).resolves.toBeUndefined()
  })

  it('refreshes the catalog when a selected model is unknown', async () => {
    const agent = {}
    let refreshed: CandidateModel | undefined
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate('nvidia', 'best-model', 'S'), candidate('openrouter', 'fallback', 'A')],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      now: () => 1_000,
      onUnknownModel: (selected) => { refreshed = selected },
    })
    await runtime.onRequest(request(agent), async () => original)
    await runtime.onRequestError({
      ...request(agent), provider: 'nvidia', failure: { code: 'UNKNOWN_MODEL', message: 'gone' }, retryPolicy: undefined,
    }, async () => undefined)

    expect(refreshed).toMatchObject({ provider: 'nvidia', model: 'best-model' })
  })
})
