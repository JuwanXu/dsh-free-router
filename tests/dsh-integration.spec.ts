import { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.js'

const original: LlmCallConfig = { provider: 'openrouter', model: 'user-selected' }

async function waitForCatalog(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('DSH integration', () => {
  const previousDshHome = process.env.DSH_HOME
  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('uses DSH request waterfalls to route and fail over real provider/model headers', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => [
        { provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
        { provider: 'nvidia', id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek' },
      ],
      stream: async function* () {},
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()

    const agent = {}
    const request = { agent, turn: 1, step: 1, signal: new AbortController().signal }
    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const selected = await waterfall(ctx, 'agent/request', request, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })

    await expect(waterfall(ctx, 'agent/request-error', {
      ...request,
      provider: 'nvidia',
      failure: { code: 'RATE_LIMIT', message: 'slow down' },
      retryPolicy: undefined,
    }, async () => undefined)).resolves.toEqual({ kind: 'retry' })

    const fallback = await waterfall(ctx, 'agent/request', request, async () => original)
    expect(fallback).toMatchObject({ provider: 'nvidia', model: 'deepseek-ai/deepseek-v3.2' })
    await fiber.dispose()
  })
})
