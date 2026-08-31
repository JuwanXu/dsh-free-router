import { describe, expect, it } from 'vitest'
import { OpenRouterCatalogSource } from '../src/catalog/openrouter.js'

describe('OpenRouterCatalogSource', () => {
  it('keeps only free tool-calling models with a free route', async () => {
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

    expect(models).toMatchObject([{
      provider: 'openrouter', model: 'org/free-tools:free', toolCalling: true, free: true,
    }])
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
