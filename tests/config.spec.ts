import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { providerDescriptors } from '../src/providers.js'

describe('parseConfig', () => {
  it('uses safe routing defaults', () => {
    const config = parseConfig({})

    expect(config.enabled).toBe(true)
    expect(config.routing).toMatchObject({
      maxAttemptsPerStep: 4,
      minimumContextWindow: 32_768,
      minimumTier: 'B',
    })
    expect(config.providers.openrouter).toEqual({ enabled: true, route: 'openrouter' })
  })

  it('rejects invalid attempt budgets and unknown providers', () => {
    expect(() => parseConfig({ routing: { maxAttemptsPerStep: 0 } })).toThrow(/maxAttemptsPerStep/)
    expect(() => parseConfig({ providers: { other: { route: 'x' } } })).toThrow(/providers/)
  })

  it('derives every provider default from its descriptor', () => {
    const config = parseConfig({})
    const expected = Object.fromEntries(providerDescriptors.map((descriptor) => [
      descriptor.key,
      descriptor.config,
    ]))

    expect(config.providers).toEqual(expected)
  })
})
