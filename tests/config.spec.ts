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
      minimumTier: '?',
    })
    expect(config.catalog).toEqual({ zeroPricedWithoutSuffix: true })
    expect(config.providers.openrouter).toEqual({ enabled: true, route: 'openrouter' })
  })

  it('parses zero-priced model catalog policy strictly', () => {
    expect(parseConfig({ catalog: { zeroPricedWithoutSuffix: false } }).catalog)
      .toEqual({ zeroPricedWithoutSuffix: false })
    expect(() => parseConfig({ catalog: null })).toThrow(TypeError)
    expect(() => parseConfig({ catalog: { zeroPricedWithoutSuffix: 'false' } })).toThrow(TypeError)
    expect(() => parseConfig({ catalog: { zeroPricedWithoutSuffix: true }, unexpected: true })).toThrow(TypeError)
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

  it('keeps dynamic registration disabled by default', () => {
    expect(parseConfig({}).registration.openrouter).toEqual({
      enabled: false,
      route: 'free-router-openrouter',
      displayName: 'Free Router · OpenRouter',
    })
  })

  it('rejects an enabled registrar targeting its source route', () => {
    expect(() => parseConfig({
      providers: { openrouter: { route: 'openrouter' } },
      registration: { openrouter: { enabled: true, route: 'openrouter' } },
    })).toThrow(/must differ/)
  })

  it('accepts a distinct managed route', () => {
    expect(parseConfig({ registration: { openrouter: {
      enabled: true, route: 'free-router-or', displayName: 'Managed OR',
    } } }).registration.openrouter.route).toBe('free-router-or')
  })

  it.each([
    { registration: { openrouter: { route: '' } } },
    { registration: { openrouter: { displayName: '' } } },
  ])('rejects malformed registration %#', (value) => expect(() => parseConfig(value)).toThrow())
})
