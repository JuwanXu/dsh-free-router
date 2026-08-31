import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { HealthBook } from '../src/health.js'
import { createRouterRuntime } from '../src/runtime/router.js'
import type { CandidateModel } from '../src/types.js'

const candidate: CandidateModel = {
  provider: 'nvidia', model: 'model', displayName: 'Model', contextWindow: 65_536,
  toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 0,
}

describe('RouterRuntime lifecycle', () => {
  it('aborts active probes and cancels future scheduling on disposal', async () => {
    let cancelled = false
    let probeSignal: AbortSignal | undefined
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      schedule: () => ({ cancel: () => { cancelled = true } }),
      probe: async (_candidate, signal) => {
        probeSignal = signal
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { kind: 'failure', code: 'TRANSPORT' }
      },
    })

    runtime.start()
    await Promise.resolve()
    await runtime.dispose()
    expect(probeSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('honors the configured global probe concurrency', async () => {
    let active = 0
    let maximumActive = 0
    const candidates = Array.from({ length: 5 }, (_, index) => ({ ...candidate, model: `model-${index}` }))
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ routing: { maxAttemptsPerStep: 5 }, health: { concurrency: 2, maxCandidatesPerProvider: 5 } }),
      getCandidates: () => candidates,
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      schedule: () => ({ cancel: () => {} }),
      probe: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { kind: 'success', firstByteMs: 1 }
      },
    })

    runtime.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await runtime.dispose()
    expect(maximumActive).toBe(2)
  })
})
