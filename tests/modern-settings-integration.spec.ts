import { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config.js'

const sourceRoute = 'openrouter'
const managedRoute = 'free-router-openrouter'
const original: LlmCallConfig = { provider: sourceRoute, model: 'user-selected' }

async function settleRefreshes(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('DSH 0.2 config-editor registration', () => {
  const previousDshHome = process.env.DSH_HOME

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('registers a zero-priced suffixless OpenRouter model through configEditor', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-modern-settings`)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{
      id: 'stealth/space-bunny-alpha',
      name: 'Space Bunny',
      context_length: 1_000_000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'],
    }] }), { status: 200 }))

    const document = {
      providers: {
        [sourceRoute]: { apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
      } as Record<string, { models?: Array<{ id: string, name: string }> }>,
    }
    const ctx = new Context()
    const entry = {
      options: { id: 'llm-pi-ai' },
      fiber: { config: { providers: { get: () => document.providers } } },
    }
    ctx.provide('settings', { configure: () => () => {} } as never)
    ctx.provide('configEditor', {
      entries: () => [entry],
      edit: async (_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
        const next = change(document, {}) as typeof document
        document.providers = next.providers
        ctx.emit('llm/adapters-updated')
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => Object.keys(document.providers).map((id) => ({ id })),
      listModels: async (route: string) => (document.providers[route]?.models ?? []).map((model) => ({ ...model, provider: route })),
      stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    } as never)

    vi.resetModules()
    const plugin = await import('../src/index.js')
    const config = parseConfig({
      providers: { openrouter: { enabled: true, route: sourceRoute }, nvidia: { enabled: false, route: 'nvidia' } },
      registration: { openrouter: { enabled: true, route: managedRoute, displayName: 'Free Router · OpenRouter' } },
      routing: { minimumTier: '?' },
    })
    const fiber = ctx.plugin(plugin, config)
    await fiber
    await settleRefreshes()

    expect(document.providers[managedRoute]?.models).toEqual([
      expect.objectContaining({ id: 'stealth/space-bunny-alpha' }),
    ])
    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<LlmCallConfig>,
    ) => Promise<LlmCallConfig>
    await expect(waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)).resolves.toMatchObject({
      provider: managedRoute,
      model: 'stealth/space-bunny-alpha',
    })
    await fiber.dispose()
  })
})
