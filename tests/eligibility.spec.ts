import { describe, expect, it } from 'vitest'
import { eligible } from '../src/eligibility.js'

const policy = (overrides: Record<string, unknown> = {}) => ({
  minimumContextWindow: 32_768,
  minimumTier: 'B',
  includeModels: [] as string[],
  excludeModels: [] as string[],
  ...overrides,
})

const candidate = (overrides: Record<string, unknown> = {}) => ({
  provider: 'openrouter',
  model: 'org/model:free',
  displayName: 'Model',
  contextWindow: 65_536,
  toolCalling: true,
  free: true,
  tier: 'A',
  catalogUpdatedAt: 0,
  ...overrides,
})

describe('eligible', () => {
  it('rejects a paid model', () => {
    expect(eligible(candidate({ free: false }), policy())).toBe(false)
  })

  it('rejects a model without tool calling', () => {
    expect(eligible(candidate({ toolCalling: false }), policy())).toBe(false)
  })

  it('rejects a model below the configured context window', () => {
    expect(eligible(candidate({ contextWindow: 8_192 }), policy())).toBe(false)
  })

  it('uses include and exclude lists by complete model id', () => {
    expect(eligible(candidate({ model: 'keep' }), policy({ includeModels: ['keep'] }))).toBe(true)
    expect(eligible(candidate({ model: 'drop' }), policy({ excludeModels: ['drop'] }))).toBe(false)
  })
})
