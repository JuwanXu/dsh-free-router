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
      ['openrouter', new Set<string>()],
    ]), new AbortController().signal)).resolves.toEqual([candidate('nvidia', 'a')])
  })
})
