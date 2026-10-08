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
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()

    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: {
        append: (type: string, data: unknown) => { events.push({ type, data }) },
      },
    }
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
    expect(events).toEqual([])
    expect(JSON.stringify(events)).not.toContain('slow down')
    expect(JSON.stringify(events)).not.toContain('recovery')
    await fiber.dispose()
  })

  it('does not write session telemetry that the harness cannot restore', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-safe-errors`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context().intercept('logger', { level: 3 })
    const logMessages: Array<{ type: string; args: unknown[] }> = []
    ctx.logger.exporter({
      export: (message) => { logMessages.push(message) },
    })
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => [
        { provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
      ],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()

    const appendCalls: unknown[][] = []
    const agent = {
      session: { append: (...args: unknown[]) => { appendCalls.push(args) } },
    }
    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    await waterfall(ctx, 'agent/request', {
      agent, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)

    const diagnostics = logMessages
      .filter((message) => message.type === 'warn')
      .flatMap((message) => message.args.map(String))
      .join('\n')
    expect(appendCalls).toEqual([])
    expect(diagnostics).not.toContain('追加选路事件')
    await fiber.dispose()
  })

  it('keeps a healthy route when another adapter model directory fails', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-partial`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }, { id: 'nvidia' }],
      listModels: async (route: string) => {
        if (route === 'openrouter') throw new Error('directory unavailable')
        return [{ provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' }]
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const selected = await waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await fiber.dispose()
  })

  it('keeps the original adapter route when registration is enabled but Settings is unavailable', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{
      id: 'first:free', name: 'First Free', context_length: 65_536,
      pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'],
    }] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-without-settings`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const config = structuredClone(defaultConfig)
    config.providers.nvidia.enabled = false
    config.registration.openrouter.enabled = true
    config.routing.minimumTier = '?'
    const ctx = new Context()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }],
      listModels: async () => [{ provider: 'openrouter', id: 'first:free', name: 'First Free' }],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, config)
    await fiber
    await waitForCatalog()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    await expect(waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)).resolves.toMatchObject({ provider: 'openrouter', model: 'first:free' })
    await fiber.dispose()
  })

  it('clears provider isolation after an adapter update even when topology is unchanged', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-isolation`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => [{ provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' }],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const firstAgent = {}
    const request = { agent: firstAgent, turn: 1, step: 1, signal: new AbortController().signal }
    await waterfall(ctx, 'agent/request', request, async () => original)
    await waterfall(ctx, 'agent/request-error', {
      ...request,
      provider: 'nvidia',
      failure: { code: 'INVALID_CREDENTIAL', message: 'bad credential' },
    }, async () => undefined)

    ctx.emit('llm/adapters-updated')
    await waitForCatalog()

    const selected = await waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await fiber.dispose()
  })

  it('clears isolation when a free-router provider is disabled and re-enabled in Settings', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-settings`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    let settingsCallbacks: { setSource(source: () => unknown): void; onChange(): void } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _namespace: string, _schema: unknown, _config: unknown, callbacks: typeof settingsCallbacks) => {
        settingsCallbacks = callbacks
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => [{ provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' }],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await waitForCatalog()
    expect(settingsCallbacks).toBeDefined()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const firstAgent = {}
    const request = { agent: firstAgent, turn: 1, step: 1, signal: new AbortController().signal }
    await waterfall(ctx, 'agent/request', request, async () => original)
    await waterfall(ctx, 'agent/request-error', {
      ...request,
      provider: 'nvidia',
      failure: { code: 'INVALID_CREDENTIAL', message: 'bad credential' },
    }, async () => undefined)

    settingsCallbacks!.setSource(() => ({ providers: { nvidia: { enabled: false } } }))
    settingsCallbacks!.onChange()
    await waitForCatalog()
    settingsCallbacks!.setSource(() => ({ providers: { nvidia: { enabled: true } } }))
    settingsCallbacks!.onChange()
    await waitForCatalog()

    const selected = await waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await fiber.dispose()
  })

  it('preserves a pending topology refresh when a newer ordinary refresh finishes first', async () => {
    const openRouterModel = {
      id: 'fallback:free',
      name: 'Fallback',
      context_length: 65_536,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'],
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [openRouterModel] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-refresh-intent`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    let releaseTopologyRefresh!: (models: Array<{ provider: string; id: string; name: string }>) => void
    let topologyRefreshStarted!: () => void
    const heldModels = new Promise<Array<{ provider: string; id: string; name: string }>>((resolve) => {
      releaseTopologyRefresh = resolve
    })
    const topologyRefreshEntered = new Promise<void>((resolve) => { topologyRefreshStarted = resolve })
    let nvidiaDirectoryCalls = 0
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }, { id: 'nvidia' }],
      listModels: async (route: string) => {
        if (route === 'openrouter') return [{ provider: route, id: 'fallback:free', name: 'Fallback' }]
        nvidiaDirectoryCalls += 1
        if (nvidiaDirectoryCalls === 2) {
          topologyRefreshStarted()
          return heldModels
        }
        return [
          { provider: route, id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
          ...(nvidiaDirectoryCalls >= 3
            ? [{ provider: route, id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek' }]
            : []),
        ]
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const config = {
      ...defaultConfig,
      routing: { ...defaultConfig.routing, minimumTier: '?' as const },
    }
    const fiber = ctx.plugin(plugin, config)
    await fiber
    await waitForCatalog()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const firstRequest = { agent: {}, turn: 1, step: 1, signal: new AbortController().signal }
    const first = await waterfall(ctx, 'agent/request', firstRequest, async () => original)
    expect(first).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await waterfall(ctx, 'agent/request-error', {
      ...firstRequest,
      provider: 'nvidia',
      failure: { code: 'INVALID_CREDENTIAL', message: 'bad credential' },
    }, async () => undefined)

    ctx.emit('llm/adapters-updated')
    await topologyRefreshEntered

    const fallbackRequest = { agent: {}, turn: 1, step: 1, signal: new AbortController().signal }
    const fallback = await waterfall(ctx, 'agent/request', fallbackRequest, async () => original)
    expect(fallback).toMatchObject({ provider: 'openrouter', model: 'fallback:free' })
    await waterfall(ctx, 'agent/request-error', {
      ...fallbackRequest,
      provider: 'openrouter',
      failure: { code: 'UNKNOWN_MODEL', message: 'missing model' },
    }, async () => undefined)
    await waitForCatalog()

    releaseTopologyRefresh([
      { provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
      { provider: 'nvidia', id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek' },
    ])
    await waitForCatalog()

    const selected = await waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await fiber.dispose()
  })

  it('retains topology refresh intent while an adapter model directory is unavailable', async () => {
    const openRouterModel = {
      id: 'fallback:free',
      name: 'Fallback',
      context_length: 65_536,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'],
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [openRouterModel] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-unobserved-topology`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    let nvidiaDirectoryCalls = 0
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }, { id: 'nvidia' }],
      listModels: async (route: string) => {
        if (route === 'openrouter') return [{ provider: route, id: 'fallback:free', name: 'Fallback' }]
        nvidiaDirectoryCalls += 1
        if (nvidiaDirectoryCalls === 2) throw new Error('directory unavailable')
        return [
          { provider: route, id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
          ...(nvidiaDirectoryCalls === 1
            ? [{ provider: route, id: 'not-in-free-catalog', name: 'Non-candidate' }]
            : []),
        ]
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      routing: { ...defaultConfig.routing, minimumTier: '?' },
    })
    await fiber
    await waitForCatalog()

    const waterfall = ctx.events.waterfall.bind(ctx.events) as (
      thisArg: object,
      event: string,
      payload: object,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const firstRequest = { agent: {}, turn: 1, step: 1, signal: new AbortController().signal }
    await waterfall(ctx, 'agent/request', firstRequest, async () => original)
    await waterfall(ctx, 'agent/request-error', {
      ...firstRequest,
      provider: 'nvidia',
      failure: { code: 'INVALID_CREDENTIAL', message: 'bad credential' },
    }, async () => undefined)

    ctx.emit('llm/adapters-updated')
    await waitForCatalog()

    const fallbackRequest = { agent: {}, turn: 1, step: 1, signal: new AbortController().signal }
    const fallback = await waterfall(ctx, 'agent/request', fallbackRequest, async () => original)
    expect(fallback).toMatchObject({ provider: 'openrouter', model: 'fallback:free' })
    await waterfall(ctx, 'agent/request-error', {
      ...fallbackRequest,
      provider: 'openrouter',
      failure: { code: 'UNKNOWN_MODEL', message: 'missing model' },
    }, async () => undefined)
    await waitForCatalog()

    const selected = await waterfall(ctx, 'agent/request', {
      agent: {}, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => original)
    expect(selected).toMatchObject({ provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' })
    await fiber.dispose()
  })

  it('suppresses a failed stale catalog refresh after its provider is disabled', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-stale-warning`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context().intercept('logger', { level: 3 })
    const logMessages: Array<{ type: string; args: unknown[] }> = []
    ctx.logger.exporter({
      export: (message) => { logMessages.push(message) },
    })
    let rejectCatalog!: (error: Error) => void
    let catalogStarted!: () => void
    const catalogEntered = new Promise<void>((resolve) => { catalogStarted = resolve })
    vi.stubGlobal('fetch', () => {
      catalogStarted()
      return new Promise<Response>((_resolve, reject) => { rejectCatalog = reject })
    })
    let settingsCallbacks: { setSource(source: () => unknown): void; onChange(): void } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _namespace: string, _schema: unknown, _config: unknown, callbacks: typeof settingsCallbacks) => {
        settingsCallbacks = callbacks
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }],
      listModels: async () => [{ provider: 'openrouter', id: 'fallback:free', name: 'Fallback' }],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const initialConfig = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        nvidia: { ...defaultConfig.providers.nvidia, enabled: false },
      },
    }
    const fiber = ctx.plugin(plugin, initialConfig)
    await fiber
    await catalogEntered
    expect(settingsCallbacks).toBeDefined()

    settingsCallbacks!.setSource(() => ({
      providers: {
        openrouter: { enabled: false },
        nvidia: { enabled: false },
      },
    }))
    settingsCallbacks!.onChange()
    await waitForCatalog()
    rejectCatalog(new Error('catalog down'))
    await waitForCatalog()

    const warnings = logMessages
      .filter((message) => message.type === 'warn')
      .flatMap((message) => message.args.map(String))
    expect(warnings).not.toContainEqual(expect.stringContaining('openrouter'))
    await fiber.dispose()
  })

  it('suppresses a failed stale adapter model directory after its provider is disabled', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-stale-directory-warning`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context().intercept('logger', { level: 3 })
    const logMessages: Array<{ type: string; args: unknown[] }> = []
    ctx.logger.exporter({
      export: (message) => { logMessages.push(message) },
    })
    let rejectDirectory!: (error: Error) => void
    let directoryStarted!: () => void
    const directoryEntered = new Promise<void>((resolve) => { directoryStarted = resolve })
    const heldDirectory = new Promise<never>((_resolve, reject) => { rejectDirectory = reject })
    let settingsCallbacks: { setSource(source: () => unknown): void; onChange(): void } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _namespace: string, _schema: unknown, _config: unknown, callbacks: typeof settingsCallbacks) => {
        settingsCallbacks = callbacks
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter' }],
      listModels: async () => {
        directoryStarted()
        return heldDirectory
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        nvidia: { ...defaultConfig.providers.nvidia, enabled: false },
      },
    })
    await fiber
    await directoryEntered
    expect(settingsCallbacks).toBeDefined()

    settingsCallbacks!.setSource(() => ({
      providers: {
        openrouter: { enabled: false },
        nvidia: { enabled: false },
      },
    }))
    settingsCallbacks!.onChange()
    await waitForCatalog()
    rejectDirectory(new Error('directory down'))
    await waitForCatalog()

    const warnings = logMessages
      .filter((message) => message.type === 'warn')
      .flatMap((message) => message.args.map(String))
    expect(warnings).not.toContainEqual(expect.stringContaining('模型目录不可用'))
    await fiber.dispose()
  })

  it('does not let a hanging adapter model directory block plugin disposal', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-hanging-directory`)
    vi.resetModules()
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => {
        entered()
        return new Promise<never>(() => {})
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await started

    const outcome = await Promise.race([
      fiber.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ])

    expect(outcome).toBe('disposed')
  })
})
