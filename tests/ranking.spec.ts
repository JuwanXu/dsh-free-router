import { describe, expect, it } from 'vitest'
import { rankCandidates } from '../src/ranking.js'

const candidate = (model: string, tier: string) => ({
  provider: 'openrouter',
  model,
  displayName: model,
  contextWindow: 65_536,
  toolCalling: true,
  free: true,
  tier,
  catalogUpdatedAt: 0,
})

const metrics = (status: string, averageFirstByteMs = Number.POSITIVE_INFINITY, successRate = 0) => ({
  status,
  averageFirstByteMs,
  successRate,
  consecutiveFailures: 0,
  coolingUntil: 0,
})

describe('rankCandidates', () => {
  it('orders unknown candidates by tier before latency', () => {
    const slowS = candidate('slow-s', 'S')
    const fastA = candidate('fast-a', 'A')
    const unknownS = candidate('unknown-s', 'S')

    const ranked = rankCandidates(
      [slowS, fastA, unknownS],
      new Map([
        ['openrouter/slow-s', metrics('unavailable', 100, 1)],
        ['openrouter/fast-a', metrics('unknown', 50, 0)],
        ['openrouter/unknown-s', metrics('unknown')],
      ]),
      1,
    )

    expect(ranked.map(({ model }) => model)).toEqual(['unknown-s', 'fast-a', 'slow-s'])
  })

  it('prioritizes a confirmed available model over an unknown higher-tier model', () => {
    const ranked = rankCandidates(
      [candidate('available-b', 'B'), candidate('unknown-s', 'S')],
      new Map([
        ['openrouter/available-b', metrics('available', 1_000, 0.8)],
        ['openrouter/unknown-s', metrics('unknown')],
      ]),
      1,
    )

    expect(ranked.map(({ model }) => model)).toEqual(['available-b', 'unknown-s'])
  })

  it('uses provider and model as a deterministic final tie-breaker', () => {
    const zulu = { ...candidate('zulu', 'A'), provider: 'nvidia' }
    const alpha = candidate('alpha', 'A')

    expect(rankCandidates([zulu, alpha], new Map(), 1).map(({ model }) => model)).toEqual(['zulu', 'alpha'])
  })

  it('keeps success-rate and id tie-breakers when both latencies are unknown', () => {
    const lowSuccess = candidate('low-success', 'A')
    const highSuccess = candidate('high-success', 'A')
    const sameSuccessZulu = candidate('zulu', 'A')
    const sameSuccessAlpha = candidate('alpha', 'A')

    const ranked = rankCandidates(
      [lowSuccess, highSuccess, sameSuccessZulu, sameSuccessAlpha],
      new Map([
        ['openrouter/low-success', metrics('unknown', Number.POSITIVE_INFINITY, 0.1)],
        ['openrouter/high-success', metrics('unknown', Number.POSITIVE_INFINITY, 0.9)],
        ['openrouter/zulu', metrics('unknown', Number.POSITIVE_INFINITY, 0.5)],
        ['openrouter/alpha', metrics('unknown', Number.POSITIVE_INFINITY, 0.5)],
      ]),
      1,
    )

    expect(ranked.map(({ model }) => model)).toEqual(['high-success', 'alpha', 'zulu', 'low-success'])
  })
})
