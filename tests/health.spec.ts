import { describe, expect, it } from 'vitest'
import { HealthBook } from '../src/health.js'

describe('HealthBook', () => {
  it('cools a model after a transient failure and resets it after success', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })

    book.record('openrouter/a', { kind: 'failure', code: 'RATE_LIMIT' }, 1_000)
    expect(book.isCooling('openrouter/a', 1_001)).toBe(true)
    expect(book.snapshot('openrouter/a', 1_001).consecutiveFailures).toBe(1)

    book.record('openrouter/a', { kind: 'success', firstByteMs: 120 }, 2_000)
    expect(book.isCooling('openrouter/a', 2_000)).toBe(false)
    expect(book.snapshot('openrouter/a', 2_000)).toMatchObject({
      status: 'available',
      consecutiveFailures: 0,
      averageFirstByteMs: 120,
    })
  })

  it('isolates every model of a provider after an invalid credential', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })

    book.record('nvidia/a', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_000)

    expect(book.isCooling('nvidia/a', 1_001)).toBe(true)
    expect(book.isCooling('nvidia/b', 1_001)).toBe(true)
    expect(book.isCooling('openrouter/a', 1_001)).toBe(false)
  })

  it('includes provider cooling in snapshots for untouched sibling models', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })

    book.record('nvidia/a', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_000)

    expect(book.snapshot('nvidia/b', 1_001)).toMatchObject({ status: 'unavailable', coolingUntil: 1_100 })

    const restored = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    restored.restore({ 'nvidia/b': book.snapshot('nvidia/b', 1_001) })
    expect(restored.snapshot('nvidia/b', 2_000).status).toBe('unknown')
  })

  it('caps exponential cooldown and retains a finite rolling latency average', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 250, sampleSize: 2 })

    book.record('openrouter/a', { kind: 'failure', code: 'SERVER' }, 0)
    book.record('openrouter/a', { kind: 'failure', code: 'SERVER' }, 100)
    book.record('openrouter/a', { kind: 'failure', code: 'SERVER' }, 200)
    expect(book.snapshot('openrouter/a', 200).coolingUntil).toBe(450)

    book.record('openrouter/a', { kind: 'success', firstByteMs: 100 }, 500)
    book.record('openrouter/a', { kind: 'success', firstByteMs: 300 }, 600)
    book.record('openrouter/a', { kind: 'success', firstByteMs: 500 }, 700)
    expect(book.snapshot('openrouter/a', 700).averageFirstByteMs).toBe(400)
  })

  it('restores persisted health summaries for a cached candidate', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    book.restore({
      'nvidia/a': {
        status: 'available', averageFirstByteMs: 120, successRate: 1,
        consecutiveFailures: 0, coolingUntil: 0,
      },
    })

    expect(book.snapshot('nvidia/a', 1_000)).toMatchObject({
      status: 'available', averageFirstByteMs: 120, successRate: 1,
    })
  })

  it('restores unknown latency encoded as JSON null and can clear provider cooling', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    book.restore({
      'nvidia/a': {
        status: 'unavailable', averageFirstByteMs: null as unknown as number, successRate: 0,
        consecutiveFailures: 1, coolingUntil: 2_000,
      },
    })
    expect(book.isCooling('nvidia/a', 1_500)).toBe(true)

    book.clearProvider('nvidia')
    expect(book.isCooling('nvidia/a', 1_500)).toBe(false)
    expect(book.snapshot('nvidia/a', 1_500)).toMatchObject({ status: 'unknown', consecutiveFailures: 0 })
  })

  it('restores stale summaries as ranking hints without making them available', () => {
    const book = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 3 })
    book.restore({
      'nvidia/a': {
        status: 'available', averageFirstByteMs: 120, successRate: 1,
        consecutiveFailures: 0, coolingUntil: 0,
      },
    }, { stale: true })

    expect(book.snapshot('nvidia/a', 1_000)).toMatchObject({ status: 'unknown', averageFirstByteMs: 120, successRate: 1 })
  })
})
