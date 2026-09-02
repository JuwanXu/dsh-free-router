import { describe, expect, it } from 'vitest'
import { CatalogRegistry } from '../src/catalog/registry.js'

const candidate = (provider: string, model: string) => ({
  provider, model, displayName: model, contextWindow: 65_536,
  toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 0,
})

describe('CatalogRegistry', () => {
  it('keeps only models exposed by the active DSH provider routes', async () => {
    const registry = new CatalogRegistry([
      { load: async () => [candidate('nvidia', 'a')] },
      { load: async () => [candidate('openrouter', 'b')] },
    ])

    await expect(registry.refresh(new Map([
      ['nvidia', new Set(['a'])],
      ['openrouter', new Set(['cached:free'])],
    ]), new AbortController().signal)).resolves.toEqual([candidate('nvidia', 'a')])
  })

  it('keeps a healthy provider catalog when another provider refresh fails', async () => {
    const registry = new CatalogRegistry([
      { load: async () => [candidate('nvidia', 'a')] },
      { provider: 'openrouter', load: async () => { throw new Error('OpenRouter unavailable') } },
    ])

    await expect(registry.refresh(new Map([
      ['nvidia', new Set(['a'])],
      ['openrouter', new Set(['cached:free'])],
    ]), new AbortController().signal, [candidate('openrouter', 'cached:free')])).resolves.toEqual([
      candidate('nvidia', 'a'), candidate('openrouter', 'cached:free'),
    ])
  })

  it('isolates a catalog source that does not settle before its timeout', async () => {
    const registry = new CatalogRegistry([
      {
        provider: 'openrouter',
        load: async (signal) => new Promise<readonly ReturnType<typeof candidate>[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
        }),
      },
      { provider: 'nvidia', load: async () => [candidate('nvidia', 'a')] },
    ], 1)

    await expect(registry.refresh(new Map([
      ['nvidia', new Set(['a'])],
      ['openrouter', new Set(['cached:free'])],
    ]), new AbortController().signal, [candidate('openrouter', 'cached:free')])).resolves.toEqual([
      candidate('nvidia', 'a'), candidate('openrouter', 'cached:free'),
    ])
  })

  it('reports a failed active catalog source without exposing its error payload', async () => {
    const warnings: string[] = []
    const registry = new CatalogRegistry([
      { provider: 'openrouter', load: async () => { throw new Error('Bearer secret must not escape') } },
    ], 10)

    await registry.refresh(new Map([
      ['openrouter', new Set(['cached:free'])],
    ]), new AbortController().signal, [candidate('openrouter', 'cached:free')], (provider) => warnings.push(provider))

    expect(warnings).toEqual(['openrouter'])
  })

  it('does not load or warn for a source whose provider has no executable route', async () => {
    let loaded = false
    const warnings: string[] = []
    const registry = new CatalogRegistry([
      {
        provider: 'openrouter',
        load: async () => {
          loaded = true
          throw new Error('must not load disabled provider')
        },
      },
    ], 10)

    await expect(registry.refresh(new Map([
      ['openrouter', new Set()],
    ]), new AbortController().signal, [], (provider) => warnings.push(provider))).resolves.toEqual([])

    expect(loaded).toBe(false)
    expect(warnings).toEqual([])
  })

  it('does not report source failures caused by refresh cancellation', async () => {
    const warnings: string[] = []
    const registry = new CatalogRegistry([
      {
        provider: 'openrouter',
        load: async (signal) => new Promise<readonly ReturnType<typeof candidate>[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      },
    ], 10)
    const controller = new AbortController()
    const refresh = registry.refresh(new Map([
      ['openrouter', new Set(['cached:free'])],
    ]), controller.signal, [candidate('openrouter', 'cached:free')], (provider) => warnings.push(provider))

    controller.abort()
    await refresh

    expect(warnings).toEqual([])
  })
})
