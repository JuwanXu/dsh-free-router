import { describe, expect, it } from 'vitest'
import { OpenRouterCatalogSource } from '../src/catalog/openrouter.js'

describe('OpenRouterCatalogSource', () => {
  it('uses zero pricing and the suffix policy to qualify safe tool models', async () => {
    const eligible = (id: string, extra: Record<string, unknown> = {}) => ({
      id, name: id, context_length: 65_536,
      pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], ...extra,
    })
    const data = [
      eligible('org/suffixed:free'), eligible('stealth/space-bunny-alpha'), eligible('openrouter/free'),
      eligible('org/paid', { pricing: { prompt: '0.01', completion: '0' } }),
      eligible('org/missing-pricing', { pricing: undefined }),
      eligible('org/no-tools', { supported_parameters: [] }),
      eligible('org/zero-context', { context_length: 0 }),
      eligible('org/negative-context', { context_length: -1 }),
      eligible('org/unsafe-context', { context_length: Number.MAX_SAFE_INTEGER + 1 }),
    ]
    const fetchImpl = async () => new Response(JSON.stringify({ data }))
    const defaultSource = new OpenRouterCatalogSource(fetchImpl)
    const compatibilitySource = new OpenRouterCatalogSource(fetchImpl, undefined, undefined, undefined, false)

    expect((await defaultSource.load(new AbortController().signal)).map(({ model }) => model))
      .toEqual(['org/suffixed:free', 'stealth/space-bunny-alpha'])
    expect((await compatibilitySource.load(new AbortController().signal)).map(({ model }) => model))
      .toEqual(['org/suffixed:free'])
  })

  it('keeps only zero-priced tool-calling models', async () => {
    const source = new OpenRouterCatalogSource(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'org/paid', name: 'Paid', context_length: 65_536,
          pricing: { prompt: '0.001', completion: '0.001' }, supported_parameters: ['tools'],
        },
        {
          id: 'org/chat:free', name: 'Chat', context_length: 65_536,
          pricing: { prompt: '0', completion: '0' }, supported_parameters: [],
        },
        {
          id: 'org/not-a-free-route', name: 'Not a route', context_length: 65_536,
          pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'],
        },
        {
          id: 'org/free-tools:free', name: 'Free Tools', context_length: 131_072,
          pricing: { prompt: '0', completion: '0.0' }, supported_parameters: ['tools', 'temperature'],
        },
      ],
    })))

    const models = await source.load(new AbortController().signal)

    expect(models.map(({ model }) => model)).toEqual(['org/not-a-free-route', 'org/free-tools:free'])
    expect(models).toMatchObject([
      { provider: 'openrouter', model: 'org/not-a-free-route', toolCalling: true, free: true },
      { provider: 'openrouter', model: 'org/free-tools:free', toolCalling: true, free: true },
    ])
  })

  it('rejects a malformed directory response', async () => {
    const source = new OpenRouterCatalogSource(async () => new Response(JSON.stringify({ data: null })))

    await expect(source.load(new AbortController().signal)).rejects.toThrow('OpenRouter model directory')
  })

  it('aborts a slow directory request after the configured timeout', async () => {
    const source = new OpenRouterCatalogSource(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
    }), undefined, undefined, 1)

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
