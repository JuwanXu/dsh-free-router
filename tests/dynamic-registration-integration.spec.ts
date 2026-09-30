import { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, type RouterConfig } from '../src/config.js'
import type { FreeRouterCommandRegistry } from '../src/commands.js'

const sourceRoute = 'openrouter'
const managedRoute = 'free-router-openrouter'
const sourceProfile = {
  apiKeyEnv: 'OPENROUTER_API_KEY',
  baseURL: 'https://openrouter.ai/api/v1',
  headers: { 'HTTP-Referer': 'https://example.test' },
}
const original: LlmCallConfig = { provider: sourceRoute, model: 'user-selected' }

function freeModel(id: string, name: string) {
  return {
    id,
    name,
    context_length: 65_536,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools'],
  }
}

function registrationConfig(overrides: Record<string, unknown> = {}): RouterConfig {
  return parseConfig({
    providers: {
      openrouter: { enabled: true, route: sourceRoute },
      nvidia: { enabled: false, route: 'nvidia' },
    },
    registration: { openrouter: { enabled: true, route: managedRoute, displayName: 'Free Router · OpenRouter' } },
    routing: { minimumTier: '?', ...overrides },
  })
}

async function settleRefreshes(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function requestThroughWaterfall(ctx: Context, agent: object = {}): Promise<LlmCallConfig> {
  const waterfall = ctx.events.waterfall.bind(ctx.events) as (
    thisArg: object,
    event: string,
    payload: object,
    next: () => Promise<unknown>,
  ) => Promise<LlmCallConfig>
  return waterfall(ctx, 'agent/request', {
    agent, turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => original)
}

async function reportFailure(ctx: Context, agent: object, code: string): Promise<void> {
  const waterfall = ctx.events.waterfall.bind(ctx.events) as (
    thisArg: object,
    event: string,
    payload: object,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  await waterfall(ctx, 'agent/request-error', {
    agent, turn: 1, step: 1, provider: managedRoute,
    signal: new AbortController().signal,
    failure: { code, message: 'private upstream detail' },
  }, async () => undefined)
}

interface StartedPlugin {
  ctx: Context
  mutations: Array<{ ns: string, ops: Array<{ op: string, path: readonly string[], value?: unknown }> }>
  document: Record<string, unknown>
  modelReads: Map<string, number>
  diagnostics: string[]
  command?: Parameters<FreeRouterCommandRegistry['register']>[0]
  updateConfig(config: RouterConfig): void
  delayCatalog(): { started: Promise<void>, release(): void }
  delayModelRead(): { started: Promise<void>, release(): void }
  catalogReads(): number
  failCatalog(): void
  failMutation(): void
  releaseProbes(): void
  dispose(): Promise<void>
}

async function startPlugin(options: {
  config?: RouterConfig
  targetProfile?: unknown
  source?: Record<string, unknown> | null
  logger?: boolean
  holdProbes?: boolean
  commands?: boolean | 'throw'
} = {}): Promise<StartedPlugin> {
  let activeConfig = options.config ?? registrationConfig()
  let command: StartedPlugin['command']
  const document: Record<string, unknown> = {
    'llm-pi-ai': {
      providers: {
        ...(options.source === null ? {} : { openrouter: options.source ?? sourceProfile }),
        ...(options.targetProfile === undefined ? {} : { [managedRoute]: options.targetProfile }),
      },
    },
  }
  const mutations: StartedPlugin['mutations'] = []
  const modelReads = new Map<string, number>()
  let catalogFailure = false
  let mutationFailure = false
  let catalogReadCount = 0
  let catalogGate: { wait: Promise<void>, started: () => void } | undefined
  let modelGate: { wait: Promise<void>, started: () => void } | undefined
  let releaseProbes!: () => void
  const probesReleased = new Promise<void>((resolve) => { releaseProbes = resolve })
  const ctx = options.logger === true ? new Context().intercept('logger', { level: 3 }) : new Context()
  const diagnostics: string[] = []
  if (options.logger === true) {
    ctx.logger.exporter({
      export: (message) => {
        if (message.type === 'warn') diagnostics.push(message.args.map(String).join(' '))
      },
    })
  }
  vi.stubGlobal('fetch', async () => {
    catalogReadCount += 1
    if (catalogGate !== undefined) {
      const gate = catalogGate
      gate.started()
      await gate.wait
    }
    if (catalogFailure) throw Object.assign(new Error('Authorization: Bearer catalog-secret'), { code: 'AUTH' })
    return new Response(JSON.stringify({ data: [
      freeModel('first:free', 'First Free'),
      freeModel('second:free', 'Second Free'),
      freeModel('stealth/space-bunny-alpha', 'Space Bunny'),
      freeModel('openrouter/free', 'OpenRouter Free'),
    ] }), { status: 200 })
  })
  if (options.commands) ctx.provide('commands', {
    register: (registered: NonNullable<StartedPlugin['command']>) => {
      if (options.commands === 'throw') throw new Error('Bearer command-secret')
      command = registered
    },
  } as never)
  ctx.provide('settings', {
    get: (ns: string) => document[ns],
    mutate: async (ns: string, ops: StartedPlugin['mutations'][number]['ops']) => {
      if (mutationFailure) throw Object.assign(new Error('Bearer mutation-secret'), { code: 'EIO' })
      mutations.push({ ns, ops: [...ops] })
      const section = document[ns] as Record<string, unknown>
      for (const operation of ops) {
        if (operation.op !== 'set' || operation.value === undefined) continue
        let cursor = section
        for (const segment of operation.path.slice(0, -1)) {
          const next = cursor[segment]
          if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {}
          cursor = cursor[segment] as Record<string, unknown>
        }
        cursor[operation.path.at(-1)!] = operation.value
      }
      ctx.emit('llm/adapters-updated')
    },
    installSection: (_ctx: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: { setSource(source: () => unknown): void }) => {
      hooks.setSource(() => activeConfig)
    },
  } as never)
  ctx.provide('llm', {
    listProviders: () => {
      const providers = (document['llm-pi-ai'] as { providers: Record<string, unknown> }).providers
      return [{ id: sourceRoute }, ...(managedRoute in providers ? [{ id: managedRoute }] : [])]
    },
    listModels: async (route: string) => {
      modelReads.set(route, (modelReads.get(route) ?? 0) + 1)
      if (route === managedRoute && modelGate !== undefined) {
        const gate = modelGate
        gate.started()
        await gate.wait
      }
      return route === managedRoute
        ? [{ provider: managedRoute, id: 'first:free', name: 'First Free' }, { provider: managedRoute, id: 'second:free', name: 'Second Free' }]
        : []
    },
    stream: async function* (streamOptions: { model?: string }) {
      if (options.holdProbes === true) await probesReleased
      if (streamOptions.model === 'second:free') await new Promise((resolve) => setTimeout(resolve, 5))
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as never)
  vi.resetModules()
  const plugin = await import('../src/index.js')
  const fiber = ctx.plugin(plugin, activeConfig)
  await fiber
  await settleRefreshes()
  return {
    ctx,
    mutations,
    document,
    modelReads,
    diagnostics,
    get command() { return command },
    updateConfig: (config) => { activeConfig = config; ctx.emit('llm/adapters-updated') },
    delayCatalog: () => {
      let started!: () => void
      let release!: () => void
      const startedPromise = new Promise<void>((resolve) => { started = resolve })
      const wait = new Promise<void>((resolve) => { release = resolve })
      catalogGate = { wait, started }
      return { started: startedPromise, release: () => { catalogGate = undefined; release() } }
    },
    delayModelRead: () => {
      let started!: () => void
      let release!: () => void
      const startedPromise = new Promise<void>((resolve) => { started = resolve })
      const wait = new Promise<void>((resolve) => { release = resolve })
      modelGate = { wait, started }
      return { started: startedPromise, release: () => { modelGate = undefined; release() } }
    },
    catalogReads: () => catalogReadCount,
    failCatalog: () => { catalogFailure = true },
    failMutation: () => { mutationFailure = true },
    releaseProbes,
    dispose: () => fiber.dispose(),
  }
}

describe('dynamic free-model registration', () => {
  const previousDshHome = process.env.DSH_HOME

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('discovers then registers OpenRouter free models before selecting the managed adapter', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-registration`)
    const started = await startPlugin({ holdProbes: true })

    expect(started.mutations).toEqual([expect.objectContaining({
      ns: 'llm-pi-ai',
      ops: [expect.objectContaining({
        path: ['providers', managedRoute],
        value: expect.objectContaining({
          apiKeyEnv: 'OPENROUTER_API_KEY',
          models: [expect.objectContaining({ id: 'first:free' }), expect.objectContaining({ id: 'second:free' }), expect.objectContaining({ id: 'stealth/space-bunny-alpha' })],
        }),
      })],
    })])
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute, model: 'first:free' })
    started.releaseProbes()
    await started.dispose()
  })

  it('manual refresh removes a zero-priced suffixless model after the catalog policy is disabled', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-policy`)
    const started = await startPlugin({ commands: true })
    expect(started.command?.name).toBe('free-router')
    started.updateConfig(parseConfig({ ...registrationConfig(), catalog: { zeroPricedWithoutSuffix: false } }))
    const output = await started.command!.handler({ rawInput: 'refresh' })
    const profile = (started.document['llm-pi-ai'] as { providers: Record<string, { models: { id: string }[] }> }).providers[managedRoute]
    expect(profile.models.map((model) => model.id)).not.toContain('stealth/space-bunny-alpha')
    expect(output.text).toContain('registration: update')
    expect(output.text).toContain('removed: stealth/space-bunny-alpha')
    expect(output.text).toContain('candidates: 2')
    const catalogReads = started.catalogReads()
    const status = await started.command!.handler({ rawInput: 'status' })
    expect(status.text).toContain('registration: update')
    expect(started.catalogReads()).toBe(catalogReads)
    await started.dispose()
  })

  it('waits for an overlapping automatic refresh and managed adapter readback before replying', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-overlap`)
    const started = await startPlugin({ commands: true })
    const baselineWrites = started.mutations.length
    const baselineReads = started.modelReads.get(managedRoute) ?? 0
    const gate = started.delayCatalog()
    started.updateConfig(parseConfig({ ...registrationConfig(), catalog: { zeroPricedWithoutSuffix: false } }))
    await gate.started
    let settled = false
    const response = started.command!.handler({ rawInput: 'refresh' }).then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.release()
    const output = await response
    expect(started.mutations).toHaveLength(baselineWrites + 1)
    expect(started.modelReads.get(managedRoute)).toBeGreaterThan(baselineReads)
    expect(output.text).toContain('registration: update')
    expect(output.text).toContain('candidates: 2')
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute, model: 'first:free' })
    await started.dispose()
  })

  it('runs a full discovery for a manual request arriving during adapter verification', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-verify-overlap`)
    const started = await startPlugin({ commands: true })
    const baselineReads = started.catalogReads()
    const baselineWrites = started.mutations.length
    const gate = started.delayModelRead()
    started.updateConfig(parseConfig({ ...registrationConfig(), catalog: { zeroPricedWithoutSuffix: false } }))
    await gate.started
    let settled = false
    const response = started.command!.handler({ rawInput: 'refresh' }).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.release()
    const output = await response
    expect(started.catalogReads()).toBeGreaterThanOrEqual(baselineReads + 2)
    expect(started.mutations).toHaveLength(baselineWrites + 1)
    expect(output.text).toContain('registration: unchanged')
    expect(output.text).toContain('candidates: 2')
    await started.dispose()
  })

  it('reports target conflict without overwriting the unmanaged route', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-conflict-report`)
    const started = await startPlugin({ commands: true, targetProfile: { apiKeyEnv: 'OTHER_KEY' } })
    const output = await started.command!.handler({ rawInput: 'refresh' })
    expect(started.mutations).toEqual([])
    expect(output.text).toContain('registration: conflict')
    expect(output.text).toContain('reason: target-exists')
    await started.dispose()
  })

  it('reports a missing source and a failed catalog without exposing secrets or clearing candidates', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-report-failures`)
    const started = await startPlugin({ commands: true, logger: true })
    started.failCatalog()
    const failed = await started.command!.handler({ rawInput: 'refresh' })
    expect(failed.text).toContain('openrouter:UNKNOWN')
    expect(failed.text).toContain('candidates: 2')
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute })
    const providers = (started.document['llm-pi-ai'] as { providers: Record<string, unknown> }).providers
    delete providers[sourceRoute]
    const missing = await started.command!.handler({ rawInput: 'refresh' })
    expect(missing.text).toContain('registration: skipped')
    expect(missing.text).toContain('reason: missing-source-profile')
    expect(missing.text).toContain('registration:ENOENT')
    expect(missing.text).not.toMatch(/Bearer|catalog-secret/)
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute })
    await started.dispose()
  })

  it('continues loading when optional command registration throws', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-command-registration`)
    const started = await startPlugin({ commands: 'throw', logger: true })
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute })
    expect(started.diagnostics.join('\n')).not.toContain('command-secret')
    await started.dispose()
  })

  it('reports a rejected managed write with a safe code and preserves known candidates', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-write-failure`)
    const started = await startPlugin({ commands: true, logger: true })
    const baselineWrites = started.mutations.length
    started.failMutation()
    started.updateConfig(parseConfig({ ...registrationConfig(), catalog: { zeroPricedWithoutSuffix: false } }))
    const output = await started.command!.handler({ rawInput: 'refresh' })
    expect(output.text).toContain('registration: error')
    expect(output.text).toContain('registration:EIO')
    expect(output.text).toContain('candidates: 2')
    expect(output.text).not.toContain('mutation-secret')
    expect(started.mutations).toHaveLength(baselineWrites)
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute })
    await started.dispose()
  })

  it('settles a pending manual refresh when the plugin is disposed', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-dispose-refresh`)
    const started = await startPlugin({ commands: true })
    const gate = started.delayCatalog()
    const response = started.command!.handler({ rawInput: 'refresh' })
    await gate.started
    await started.dispose()
    const output = await response
    expect(output.text).toContain('registration: skipped')
    expect(output.text).toContain('refresh:ABORT_ERR')
    gate.release()
  })

  it('reports invalid live Settings safely and retains the previous candidate snapshot', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-settings-failure`)
    const started = await startPlugin({ commands: true, logger: true })
    started.updateConfig({ ...registrationConfig(), catalog: { zeroPricedWithoutSuffix: 'invalid' } } as unknown as RouterConfig)
    const output = await started.command!.handler({ rawInput: 'refresh' })
    expect(output.text).toContain('refresh:UNKNOWN')
    expect(output.text).toContain('candidates: 2')
    expect(output.text).not.toContain('invalid')
    await started.dispose()
  })

  it('keeps ordinary source headers but excludes credentials from Settings mutations and cache', async () => {
    const home = join(tmpdir(), `dsh-free-router-test-${Date.now()}-header-projection`)
    process.env.DSH_HOME = home
    const started = await startPlugin({
      source: {
        ...sourceProfile,
        headers: {
          'X-Client': 'free-router',
          Authorization: 'Bearer settings-secret',
          'Proxy-Authorization': 'Basic proxy-secret',
          'X-API-Key': 'api-key-secret',
          'api-key': 'duplicate-api-key-secret',
        },
      },
    })

    const registered = started.mutations[0]?.ops[0]?.value as { headers?: unknown }
    expect(registered.headers).toEqual({ 'X-Client': 'free-router' })
    expect(JSON.stringify(started.mutations)).not.toMatch(/settings-secret|proxy-secret|api-key-secret|duplicate-api-key-secret/)
    await started.dispose()
    await expect(readFile(join(home, 'cache', 'free-router.json'), 'utf8'))
      .resolves.not.toMatch(/settings-secret|proxy-secret|api-key-secret|duplicate-api-key-secret/)
  })

  it('does not overwrite an unmanaged target route', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-conflict`)
    const started = await startPlugin({ targetProfile: { apiKeyEnv: 'OTHER_KEY' } })

    expect(started.mutations).toEqual([])
    await started.dispose()
  })

  it('removes cached OpenRouter candidates when the managed target becomes a conflict', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-conflict-after-registration`)
    const started = await startPlugin()
    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute })

    const providers = (started.document['llm-pi-ai'] as { providers: Record<string, unknown> }).providers
    providers[managedRoute] = { apiKeyEnv: 'OTHER_KEY' }
    started.ctx.emit('llm/adapters-updated')
    await settleRefreshes()

    await expect(requestThroughWaterfall(started.ctx)).resolves.toEqual(original)
    await started.dispose()
  })

  it('does not write again after its own adapter update', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-loop`)
    const started = await startPlugin()

    await settleRefreshes()
    expect(started.mutations).toHaveLength(1)
    expect(started.modelReads.get(managedRoute)).toBe(1)
    await started.dispose()
  })

  it('leaves an existing managed route untouched when registration is disabled', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-disabled`)
    const disabled = registrationConfig()
    disabled.registration.openrouter.enabled = false
    const started = await startPlugin({
      config: disabled,
      targetProfile: { apiKeyEnv: 'OPENROUTER_API_KEY', models: [] },
    })
    expect(started.mutations).toEqual([])
    await started.dispose()
  })

  it('fails over between dynamically registered models after RATE_LIMIT', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-failover`)
    const started = await startPlugin()
    const agent = {}

    expect(await requestThroughWaterfall(started.ctx, agent)).toMatchObject({ provider: managedRoute, model: 'first:free' })
    await reportFailure(started.ctx, agent, 'RATE_LIMIT')
    expect(await requestThroughWaterfall(started.ctx, agent)).toMatchObject({ provider: managedRoute, model: 'second:free' })
    await started.dispose()
  })

  it('retains the previous managed candidates after a catalog failure without exposing profile secrets', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-failure`)
    const started = await startPlugin({
      logger: true,
      source: {
        ...sourceProfile,
        apiKeyEnv: 'OPENROUTER_PRIVATE_API_KEY',
        headers: { Authorization: 'Bearer source-profile-secret' },
      },
    })
    const first = await requestThroughWaterfall(started.ctx)
    expect(first).toMatchObject({ provider: managedRoute, model: 'first:free' })
    started.failCatalog()
    started.ctx.emit('llm/adapters-updated')
    await settleRefreshes()

    expect(await requestThroughWaterfall(started.ctx)).toMatchObject({ provider: managedRoute, model: 'first:free' })
    expect(started.diagnostics.join('\n')).not.toMatch(/OPENROUTER_PRIVATE_API_KEY|source-profile-secret|catalog-secret|Authorization|Bearer/)
    await started.dispose()
  })

  it('does not mutate when the registered OpenRouter source profile is absent', async () => {
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-missing-source`)
    const started = await startPlugin({ source: null })

    expect(started.mutations).toEqual([])
    await started.dispose()
  })
})
