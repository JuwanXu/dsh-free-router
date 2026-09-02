import { markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { HealthBook } from '../src/health.js'
import { createRouterRuntime } from '../src/runtime/router.js'
import type { CandidateModel } from '../src/types.js'

const candidate: CandidateModel = {
  provider: 'nvidia', model: 'model', displayName: 'Model', contextWindow: 65_536,
  toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 0,
}

const options = (): GenerateOptions => markAgentLoopRequest({
  provider: candidate.provider,
  model: candidate.model,
  messages: [],
})

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

  it('wakes an idle monitor when a catalog becomes available', async () => {
    let candidates: CandidateModel[] = []
    const delays: number[] = []
    let cancelled = false
    let probes = 0
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ health: { activeProbeIntervalMs: 60_000, idleProbeIntervalMs: 600_000 } }),
      getCandidates: () => candidates,
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      schedule: (_callback, delayMs) => {
        delays.push(delayMs)
        return { cancel: () => { cancelled = true } }
      },
      probe: async () => {
        probes += 1
        return { kind: 'success', firstByteMs: 1 }
      },
    })

    runtime.start()
    candidates = [candidate]
    runtime.wake()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await runtime.dispose()

    expect(cancelled).toBe(true)
    expect(probes).toBe(1)
    expect(delays).toContain(60_000)
  })

  it('keeps the active cadence while eligible candidates are cooling down', async () => {
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    health.record('nvidia/model', { kind: 'failure', code: 'SERVER' }, 0)
    const delays: number[] = []
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({ health: { activeProbeIntervalMs: 60_000, idleProbeIntervalMs: 600_000 } }),
      getCandidates: () => [candidate],
      health,
      now: () => 50,
      schedule: (_callback, delayMs) => {
        delays.push(delayMs)
        return { cancel: () => {} }
      },
      probe: async () => ({ kind: 'success', firstByteMs: 1 }),
    })

    runtime.start()
    await runtime.dispose()

    expect(delays).toContain(60_000)
  })

  it('closes active observed streams during disposal', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let resolveNext!: (result: IteratorResult<StreamChunk>) => void
    let returned = false
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          entered()
          return new Promise<IteratorResult<StreamChunk>>((resolve) => { resolveNext = resolve })
        },
        return: async () => {
          returned = true
          resolveNext({ done: true, value: undefined })
          return { done: true, value: undefined }
        },
      }),
    }
    const health = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health,
    })
    const iterator = runtime.observeStream(options(), () => source)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await started

    await runtime.dispose()

    expect(returned).toBe(true)
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(health.snapshot('nvidia/model', Date.now()).status).toBe('unknown')
  })

  it('closes the source stream when its consumer stops early', async () => {
    let returned = false
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: { type: 'text-delta', index: 0, text: 'partial' } }),
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }),
    }
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
    })
    const iterator = runtime.observeStream(options(), () => source)[Symbol.asyncIterator]()

    await iterator.next()
    await iterator.return?.()

    expect(returned).toBe(true)
    await runtime.dispose()
  })

  it('does not let an uncooperative source stream block disposal forever', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const source = async function* (): AsyncIterable<StreamChunk> {
      entered()
      await new Promise<void>(() => {})
      yield { type: 'text-delta', index: 0, text: 'never' }
    }
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      disposeTimeoutMs: 5,
    })
    const iterator = runtime.observeStream(options(), source)[Symbol.asyncIterator]()
    void iterator.next()
    await started

    const outcome = await Promise.race([
      runtime.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ])

    expect(outcome).toBe('disposed')
  })

  it('settles the observed stream wrapper when disposal interrupts an uncooperative source', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const source = async function* (): AsyncIterable<StreamChunk> {
      entered()
      await new Promise<void>(() => {})
      yield { type: 'text-delta', index: 0, text: 'never' }
    }
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      disposeTimeoutMs: 5,
    })
    const iterator = runtime.observeStream(options(), source)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await started

    await runtime.dispose()
    const outcome = await Promise.race([
      pending.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ])

    expect(outcome).toBe('settled')
  })

  it('contains a synchronous source return failure during disposal', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          entered()
          return new Promise<IteratorResult<StreamChunk>>(() => {})
        },
        return: () => { throw new Error('return failed') },
      }),
    }
    const runtime = createRouterRuntime({
      getConfig: () => parseConfig({}),
      getCandidates: () => [candidate],
      health: new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 }),
      disposeTimeoutMs: 5,
    })
    const iterator = runtime.observeStream(options(), () => source)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await started

    await expect(runtime.dispose()).resolves.toBeUndefined()
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})
