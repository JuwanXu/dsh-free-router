import { describe, expect, it } from 'vitest'
import { AttemptState } from '../src/runtime/attempt-state.js'

const candidate = (model: string) => ({
  provider: 'openrouter',
  model,
  displayName: model,
  contextWindow: 65_536,
  toolCalling: true,
  free: true,
  tier: 'A',
  catalogUpdatedAt: 0,
})

describe('AttemptState', () => {
  it('does not repeat a candidate in the same agent step', () => {
    const state = new AttemptState()
    const agent = {}
    const a = candidate('a')
    const b = candidate('b')

    expect(state.next(agent, 1, 1, [a, b])).toBe(a)
    expect(state.next(agent, 1, 1, [a, b])).toBe(b)
    expect(state.next(agent, 1, 1, [a, b])).toBeUndefined()
  })

  it('allows candidates again when the agent enters a new step', () => {
    const state = new AttemptState()
    const agent = {}
    const a = candidate('a')
    const b = candidate('b')

    state.next(agent, 1, 1, [a, b])
    expect(state.next(agent, 1, 2, [a, b])).toBe(a)
  })

  it('enforces a hard per-step attempt limit even when more candidates exist', () => {
    const state = new AttemptState()
    const agent = {}
    const candidates = [candidate('a'), candidate('b'), candidate('c')]

    expect(state.next(agent, 1, 1, candidates, 2)).toBe(candidates[0])
    expect(state.next(agent, 1, 1, candidates, 2)).toBe(candidates[1])
    expect(state.next(agent, 1, 1, candidates, 2)).toBeUndefined()
    expect(state.hasRemaining(agent, 1, 1, candidates, 2)).toBe(false)
  })

  it('stops routing a step after the host delegates a non-recoverable failure', () => {
    const state = new AttemptState()
    const agent = {}
    const candidates = [candidate('a'), candidate('b')]

    expect(state.next(agent, 1, 1, candidates, 2)).toBe(candidates[0])
    state.stop(agent, 1, 1)
    expect(state.next(agent, 1, 1, candidates, 2)).toBeUndefined()
    expect(state.hasRemaining(agent, 1, 1, candidates, 2)).toBe(false)
  })
})
