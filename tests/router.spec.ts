import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { parseConfig } from '../src/config.js'
import { HealthBook } from '../src/health.js'
import { createRouterRuntime } from '../src/runtime/router.js'
import { candidateKey, type CandidateModel } from '../src/types.js'

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

  it('does not switch models later in the same step after a delegated failure', async () => {
    const agent = {}
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate('nvidia', 'first', 'S'), candidate('openrouter', 'fallback', 'A')],
      health,
      now: () => 1_000,
    })
    await runtime.onRequest(request(agent), async () => original)
    await runtime.onRequestError({
      ...request(agent), provider: 'nvidia', failure: { code: 'UNSUPPORTED_OPTION', message: 'unsupported' },
    }, async () => ({ kind: 'retry' }))

    await expect(runtime.onRequest(request(agent), async () => original)).resolves.toEqual(original)
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

  it('reports the stable code and attempted models when no fallback remains', async () => {
    const agent = {}
    const exhausted: unknown[] = []
    const dependencies = {
      getConfig: () => parseConfig({ routing: { maxAttemptsPerStep: 1 } }),
      getCandidates: () => [candidate('nvidia', 'only', 'S')],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      now: () => 1_000,
      onExhausted: (event: unknown) => exhausted.push(event),
    } as Parameters<typeof createRouterRuntime>[0] & {
      onExhausted: (event: unknown) => void
    }
    const runtime = createRouterRuntime(dependencies)

    await runtime.onRequest(request(agent), async () => original)
    await runtime.onRequestError({
      ...request(agent), provider: 'nvidia', failure: { code: 'SERVER', message: 'private failure body' },
    }, async () => undefined)

    expect(exhausted).toEqual([expect.objectContaining({
      failureCode: 'SERVER', attemptedCandidates: ['nvidia/only'], attempts: 1,
    })])
    expect(JSON.stringify(exhausted)).not.toContain('private failure body')
  })

  it('does not exceed the step attempt cap when cooling moves the ranking window', async () => {
    const agent = {}
    const candidates = Array.from({ length: 5 }, (_, index) => candidate('nvidia', `model-${index}`, 'A'))
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ routing: { maxAttemptsPerStep: 2 } }),
      getCandidates: () => candidates,
      health,
      now: () => 1_000,
    })
    const selected: string[] = []
    const downstream = async () => undefined

    for (let index = 0; index < 3; index += 1) {
      const call = await runtime.onRequest(request(agent), async () => original)
      if (call.provider === original.provider && call.model === original.model) break
      selected.push(call.model)
      const action = await runtime.onRequestError({
        ...request(agent), provider: call.provider, failure: { code: 'SERVER', message: 'bad' },
      }, downstream)
      if (action === undefined) break
    }

    expect(selected).toHaveLength(2)
    expect(selected).toEqual(['model-0', 'model-1'])
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

  it('allows the host to remove an unknown model before refreshing the catalog', async () => {
    const agent = {}
    let candidates = [candidate('nvidia', 'gone', 'S'), candidate('openrouter', 'fallback', 'A')]
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => candidates,
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      now: () => 1_000,
      onUnknownModel: (selected) => {
        candidates = candidates.filter((item) => candidateKey(item) !== candidateKey(selected))
      },
    })
    await runtime.onRequest(request(agent), async () => original)
    await runtime.onRequestError({
      ...request(agent), provider: 'nvidia', failure: { code: 'UNKNOWN_MODEL', message: 'gone' },
    }, async () => undefined)

    expect(candidates.map(candidateKey)).toEqual(['openrouter/fallback'])
  })

  it('emits bounded selection and failover telemetry without request contents', async () => {
    const agent = {}
    const selected: unknown[] = []
    const failovers: unknown[] = []
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ routing: { maxAttemptsPerStep: 2 } }),
      getCandidates: () => [candidate('nvidia', 'first', 'S'), candidate('nvidia', 'second', 'A')],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      now: () => 1_000,
      onSelected: (event) => { selected.push(event) },
      onFailover: (event) => { failovers.push(event) },
    })

    await runtime.onRequest({ ...request(agent), signal }, async () => original)
    await runtime.onRequestError({
      ...request(agent), provider: 'nvidia', failure: { code: 'RATE_LIMIT', message: 'private details' },
    }, async () => undefined)
    await runtime.onRequest({ ...request(agent), signal }, async () => original)

    expect(selected).toHaveLength(2)
    expect(failovers).toMatchObject([{
      turn: 1, step: 1, attempt: 1, failureCode: 'RATE_LIMIT',
      isolatedScope: 'model', attempts: 1, nextCandidate: { model: 'second' },
    }])
    expect(selected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: 'policy',
        metrics: expect.objectContaining({ status: 'unknown', successRate: 0 }),
      }),
    ]))
    expect(JSON.stringify(failovers)).not.toContain('private details')
  })
})
