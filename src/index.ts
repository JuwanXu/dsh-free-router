import type { Context, Logger } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CatalogRegistry } from './catalog/registry.js'
import { allowedOpenRouterModelId } from './catalog/openrouter.js'
import { registerFreeRouterCommands, type FreeRouterCommandRegistry } from './commands.js'
import { createRefreshReport, type CreateRefreshReportInput, type RefreshReport } from './refresh-report.js'
import {
  Config as ConfigSchema,
  FREE_ROUTER_SETTINGS_NAMESPACE,
  parseConfig,
  type RouterConfig,
} from './config.js'
import { eligible } from './eligibility.js'
import { HealthBook } from './health.js'
import { FileRouterCache } from './persistence/cache.js'
import { planManagedRoute } from './registration/managed-route.js'
import { reconcileManagedRoute } from './registration/reconciler.js'
import {
  createConfigEditorRegistrationSettings,
  type ConfigEditor,
  type RegistrationSettings,
} from './registration/config-editor-settings.js'
import type { ManagedRouteClaim } from './registration/types.js'
import { createRouterRuntime } from './runtime/router.js'
import { candidateKey, type CandidateModel } from './types.js'
import { providerCatalogSources, providerDescriptors } from './providers.js'

export const name = 'free-router'
export const inject = ['llm']
export const Config = ConfigSchema
export { FREE_ROUTER_SETTINGS_NAMESPACE }
export type { RouterConfig }

async function executableModels(
  ctx: Context,
  config: RouterConfig,
  previous: readonly CandidateModel[] = [],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ExecutableModelsResult> {
  const activeRoutes = new Set(ctx.llm.listProviders().map((provider) => provider.id))
  const result = new Map<string, ReadonlySet<string>>()
  const observed = new Set<string>()
  const issues: RouteIssue[] = []
  await Promise.all(providerDescriptors.map(async ({ key, source }) => {
    const provider = config.providers[key]
    const route = provider.route
    if (!provider.enabled) {
      result.set(source, new Set())
      observed.add(source)
      return
    }
    if (!activeRoutes.has(route)) {
      issues.push({ source, route, issue: 'missing' })
      result.set(source, new Set())
      observed.add(source)
      return
    }
    try {
      const models = await withAbortAndTimeout(ctx.llm.listModels(route), signal, timeoutMs)
      result.set(source, new Set(models.map((model) => model.id)))
      observed.add(source)
    } catch {
      if (!signal.aborted) issues.push({ source, route, issue: 'unavailable' })
      result.set(source, new Set(previous.filter((candidate) => candidate.provider === source).map((candidate) => candidate.model)))
    }
  }))
  return { models: result, observed, issues }
}

interface RouteIssue {
  source: string
  route: string
  issue: 'missing' | 'unavailable'
}

interface ExecutableModelsResult {
  models: ReadonlyMap<string, ReadonlySet<string>>
  observed: ReadonlySet<string>
  issues: readonly RouteIssue[]
}

function withAbortAndTimeout<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(signal.reason ?? new DOMException('操作已取消', 'AbortError')))
    const timer = setTimeout(() => finish(() => reject(new DOMException('操作超时', 'TimeoutError'))), timeoutMs)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function sourceCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const sources = new Map<string, string>(providerDescriptors.map(({ key, source }) => [config.providers[key].route, source]))
  if (config.registration.openrouter.enabled) sources.set(config.registration.openrouter.route, 'openrouter')
  return candidates.map((candidate) => ({ ...candidate, provider: sources.get(candidate.provider) ?? candidate.provider }))
}

function respectsCatalogPolicy(candidate: CandidateModel, config: RouterConfig): boolean {
  const openrouterRoutes = [
    'openrouter',
    config.providers.openrouter.route,
    config.registration.openrouter.route,
  ]
  return !openrouterRoutes.includes(candidate.provider)
    || allowedOpenRouterModelId(candidate.model, config.catalog.zeroPricedWithoutSuffix)
}

function managedProfileModelIds(profile: unknown): string[] {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const models = (profile as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  return models.flatMap((model: unknown) => model !== null && typeof model === 'object'
    && typeof (model as { id?: unknown }).id === 'string'
    ? [(model as { id: string }).id]
    : [])
}

function enabledSources(config: RouterConfig): Set<string> {
  return new Set(providerDescriptors.flatMap(({ key, source }) => config.providers[key].enabled ? [source] : []))
}

function effectiveRoutes(config: RouterConfig, managedRegistrationAvailable: boolean): RouterConfig {
  if (!managedRegistrationAvailable || !config.registration.openrouter.enabled) return config
  return {
    ...config,
    registration: {
      ...config.registration,
      // 此内部运行时配置已将来源路由替换为目标路由，需避免再次触发入口配置的同路由校验。
      openrouter: { ...config.registration.openrouter, enabled: false },
    },
    providers: {
      ...config.providers,
      openrouter: { ...config.providers.openrouter, route: config.registration.openrouter.route },
    },
  }
}

function mapOpenRouterToManagedRoute(
  candidates: readonly CandidateModel[],
  config: RouterConfig,
  managedRegistrationAvailable: boolean,
): CandidateModel[] {
  if (!managedRegistrationAvailable || !config.registration.openrouter.enabled) return [...candidates]
  return candidates.map((candidate) => candidate.provider === 'openrouter'
    ? { ...candidate, provider: config.registration.openrouter.route }
    : candidate)
}

function providerProfiles(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const providers = (value as { providers?: unknown }).providers
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? providers as Record<string, unknown>
    : undefined
}

interface ProviderTopology {
  enabled: boolean
  route: string
  models: ReadonlySet<string>
}

type IsolationRefreshIntent = 'adapter' | 'topology'

function providerTopologies(
  config: RouterConfig,
  executable: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, ProviderTopology> {
  return new Map(providerDescriptors.map(({ key, source }) => [source, {
    enabled: config.providers[key].enabled,
    route: config.providers[key].route,
    models: executable.get(source) ?? new Set(),
  }]))
}

function sameTopology(left: ProviderTopology | undefined, right: ProviderTopology): boolean {
  return left !== undefined
    && left.enabled === right.enabled
    && left.route === right.route
    && left.models.size === right.models.size
    && [...left.models].every((model) => right.models.has(model))
}

function createThrottledWarning(logger: Logger, intervalMs = 60_000): (key: string, message: string) => void {
  const lastWarnedAt = new Map<string, number>()
  return (key, message) => {
    const now = Date.now()
    const previous = lastWarnedAt.get(key) ?? Number.NEGATIVE_INFINITY
    if (now - previous < intervalMs) return
    lastWarnedAt.set(key, now)
    logger.warn(`free-router: ${message}`)
  }
}

const safeDiagnosticErrorCodes = new Set([
  'ABORT_ERR',
  'AUTH',
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
  'ETIMEDOUT',
  'INVARIANT',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'QUOTA',
  'TIMEOUT',
  'UNKNOWN',
])

function safeErrorCode(error: unknown): string {
  try {
    const code = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as { code?: unknown }).code
      : undefined
    return typeof code === 'string' && safeDiagnosticErrorCodes.has(code) ? code : 'UNKNOWN'
  } catch {
    return 'UNKNOWN'
  }
}

/** Register request-level free-model routing on top of existing DSH LLM adapters. */
export function apply(ctx: Context, entry: RouterConfig): void {
  let lastValidConfig = parseConfig(entry)
  let current: () => RouterConfig = () => lastValidConfig
  let candidates: CandidateModel[] = []
  const routableCandidates = (): CandidateModel[] => {
    let config = lastValidConfig
    try { config = current() } catch { /* 保留最后一次有效配置下的候选视图。 */ }
    return candidates.filter((candidate) => respectsCatalogPolicy(candidate, config))
  }
  let refreshGeneration = 0
  let refreshInFlight = false
  let refreshQueued = false
  let initialRefreshScheduled = false
  let registrationSettings: RegistrationSettings | undefined
  let cachedManagedClaim: ManagedRouteClaim | undefined
  let pendingManagedAdapterVerification: ManagedRouteClaim | undefined
  let lastDiscovered: CandidateModel[] = []
  let lastReport: RefreshReport | undefined
  let pendingReport: Omit<CreateRefreshReportInput, 'completedAt'> | undefined
  const refreshWaiters: Array<{ generation: number, requiresDiscovery: boolean, resolve: (report: RefreshReport) => void }> = []
  const isolationRefreshPending = new Map<string, IsolationRefreshIntent>()
  let initialRefreshCompleted = false
  let lastTopology = new Map<string, ProviderTopology>()
  const refreshAbort = new AbortController()
  const refreshTasks = new Set<Promise<void>>()
  const cacheTasks = new Set<Promise<void>>()
  const logger = ctx.logger('free-router')
  const warn = createThrottledWarning(logger)
  const health = new HealthBook({ baseCooldownMs: 5_000, maxCooldownMs: 10 * 60_000, sampleSize: 20 })
  const cache = new FileRouterCache(dshHomePath('cache', 'free-router.json'), 24 * 60 * 60_000)
  const persistCache = (): void => {
    if (refreshAbort.signal.aborted) return
    const activeCandidates = routableCandidates()
    const task = cache.save({
      version: 2,
      updatedAt: Date.now(),
      candidates: activeCandidates,
      health: health.snapshots(activeCandidates.map(candidateKey), Date.now()),
      registrations: cachedManagedClaim === undefined ? {} : { openrouter: cachedManagedClaim },
    }).catch((error) => logger.warn(`free-router: 缓存保存失败（错误码：${safeErrorCode(error)}）`))
    cacheTasks.add(task)
    void task.then(
      () => cacheTasks.delete(task),
      () => cacheTasks.delete(task),
    )
  }
  let triggerRefresh: () => Promise<RefreshReport> = async () => lastReport ?? createRefreshReport({
    startedAt: Date.now(), completedAt: Date.now(), discoveredModelIds: [], eligibleModelIds: [],
    previousModelIds: [], registeredModelIds: [], registrationKind: 'skipped', failures: [{ provider: 'refresh', code: 'ABORT_ERR' }],
  })
  const runtime = createRouterRuntime({
    getConfig: () => effectiveRoutes(current(), registrationSettings !== undefined),
    getCandidates: routableCandidates,
    health,
    onHealthChange: persistCache,
    onUnknownModel: (unknown) => {
      const unknownKey = candidateKey(unknown)
      candidates = candidates.filter((candidate) => candidateKey(candidate) !== unknownKey)
      persistCache()
      triggerRefresh()
    },
    onExhausted: (event) => {
      warn(
        `exhausted:${event.failureCode}:${event.attemptedCandidates.join(',')}`,
        `已尝试 ${event.attempts} 次但没有可用回退；候选：${event.attemptedCandidates.join(', ')}；最后故障码：${event.failureCode}`,
      )
    },
    probe: async (candidate, lifecycleSignal) => {
      const startedAt = Date.now()
      const signal = AbortSignal.any([lifecycleSignal, AbortSignal.timeout(current().health.timeoutMs)])
      let firstChunkAt: number | undefined
      for await (const chunk of ctx.llm.stream({
        provider: candidate.provider,
        model: candidate.model,
        maxTokens: 1,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'Reply with OK.' }],
          source: { kind: 'plugin', plugin: name },
        })],
        signal,
      })) {
        firstChunkAt ??= Date.now()
        if (chunk.type !== 'finish') continue
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          return { kind: 'failure', code: chunk.reason.failure.code }
        }
        return { kind: 'success', firstByteMs: Math.max(0, (firstChunkAt ?? Date.now()) - startedAt) }
      }
      return { kind: 'failure', code: 'EMPTY_RESPONSE' }
    },
  })

  const cacheLoad = cache.load(Date.now()).then((record) => {
    if (record === undefined || refreshAbort.signal.aborted || (record.stale === true && initialRefreshCompleted)) return
    cachedManagedClaim = record.registrations.openrouter
    health.restore(record.health, { stale: record.stale === true })
    if (initialRefreshCompleted) return
    const known = new Set(candidates.map(candidateKey))
    candidates = [...candidates, ...record.candidates.filter((candidate) => !known.has(candidateKey(candidate)))]
    candidates = routableCandidates()
    runtime.wake()
  }).catch((error) => {
    if (!refreshAbort.signal.aborted) logger.warn(`free-router: 缓存加载失败（错误码：${safeErrorCode(error)}）`)
  })

  const refresh = async (generation: number): Promise<RefreshReport | undefined> => {
    await cacheLoad
    if (generation !== refreshGeneration || refreshAbort.signal.aborted) return
    const config = current()
    const verifying = pendingManagedAdapterVerification !== undefined
    const catalog = new CatalogRegistry(providerCatalogSources(config.catalog))
    const startedAt = pendingReport?.startedAt ?? Date.now()
    let draft: Omit<CreateRefreshReportInput, 'completedAt'> = pendingReport ?? {
      startedAt, discoveredModelIds: [], eligibleModelIds: [],
      previousModelIds: [], registeredModelIds: [],
      registrationKind: 'skipped', failures: [],
    }
    const failures = [...draft.failures]
    const complete = (): RefreshReport => {
      pendingReport = undefined
      persistCache()
      runtime.wake()
      return createRefreshReport({ ...draft, failures, candidateCount: routableCandidates().length, completedAt: Date.now() })
    }
    try {
      const previous = sourceCatalogCandidates(routableCandidates(), config)
      const discovered = !verifying
        ? (await catalog.discover(enabledSources(config), refreshAbort.signal, previous, (provider) => {
          failures.push({ provider, code: 'UNKNOWN' })
          const descriptor = providerDescriptors.find(({ source }) => source === provider)
          if (generation !== refreshGeneration
            || refreshAbort.signal.aborted
            || descriptor === undefined
            || !current().providers[descriptor.key].enabled) return
          warn(`catalog:${provider}`, `${provider} 模型目录刷新失败；继续保留上次验证通过的快照`)
        })).filter((candidate) => respectsCatalogPolicy(candidate, config))
        : lastDiscovered.filter((candidate) => respectsCatalogPolicy(candidate, config))
      if (generation !== refreshGeneration || refreshAbort.signal.aborted) return

      if (!verifying) {
        lastDiscovered = discovered
        draft = {
          ...draft,
          discoveredModelIds: discovered.map((candidate) => candidate.model),
          eligibleModelIds: discovered.filter((candidate) => eligible(candidate, config.routing)).map((candidate) => candidate.model),
        }
      }
      const registration = config.registration.openrouter
      if (registrationSettings !== undefined && registration.enabled && !verifying) {
        const profiles = providerProfiles(registrationSettings.get('llm-pi-ai'))
        const registeredModelIds = managedProfileModelIds(profiles?.[registration.route])
        draft = { ...draft, previousModelIds: registeredModelIds, registeredModelIds }
        const sourceRoute = config.providers.openrouter.route
        const sourceProfile = profiles?.[sourceRoute]
        if (profiles === undefined
          || sourceProfile === undefined
          || sourceProfile === null
          || typeof sourceProfile !== 'object'
          || Array.isArray(sourceProfile)) {
          warn('registration:openrouter:missing-source-profile', 'OpenRouter 来源配置缺失；继续保留上次验证通过的候选')
          draft = { ...draft, registrationKind: 'skipped', registrationReason: 'missing-source-profile' }
          failures.push({ provider: 'registration', code: 'ENOENT' })
          return complete()
        }
        const planned = planManagedRoute(
          sourceProfile as Record<string, unknown>,
          sourceRoute,
          registration,
          discovered.filter((candidate) => candidate.provider === 'openrouter' && eligible(candidate, config.routing)),
        )
        const reconciliation = reconcileManagedRoute(profiles, planned, cachedManagedClaim)
        if (reconciliation.kind === 'conflict') {
          draft = { ...draft, registrationKind: 'conflict', registrationReason: reconciliation.reason }
          failures.push({ provider: 'registration', code: 'INVARIANT' })
          candidates = candidates.filter((candidate) => candidate.provider !== registration.route)
          warn(`registration:openrouter:${reconciliation.reason}`, '托管 OpenRouter 路由已由其他配置占用；已移除该路由的候选')
          return complete()
        }
        if (reconciliation.kind === 'create' || reconciliation.kind === 'update') {
          draft = { ...draft, registrationKind: reconciliation.kind }
          pendingReport = { ...draft, failures }
          pendingManagedAdapterVerification = reconciliation.claim
          try {
            await registrationSettings.mutate('llm-pi-ai', reconciliation.ops)
          } catch (error) {
            pendingManagedAdapterVerification = undefined
            draft = { ...draft, registrationKind: 'error' }
            failures.push({ provider: 'registration', code: safeErrorCode(error) })
            return complete()
          }
          if (refreshAbort.signal.aborted) return
          cachedManagedClaim = reconciliation.claim
          pendingReport = { ...draft, registeredModelIds: reconciliation.claim.modelIds, failures }
          persistCache()
          if (generation === refreshGeneration) void scheduleRefresh(undefined, true)
          return
        }
        draft = { ...draft, registrationKind: 'unchanged' }
        cachedManagedClaim = reconciliation.claim
      }

      const effectiveConfig = effectiveRoutes(config, registrationSettings !== undefined)
      const executable = await executableModels(
        ctx,
        effectiveConfig,
        previous,
        refreshAbort.signal,
        config.health.timeoutMs,
      )
      if (verifying && registrationSettings !== undefined && pendingManagedAdapterVerification !== undefined) {
        const profiles = providerProfiles(registrationSettings.get('llm-pi-ai'))
        draft = {
          ...draft,
          registeredModelIds: managedProfileModelIds(profiles?.[pendingManagedAdapterVerification.targetRoute]),
        }
      }
      for (const issueDetail of executable.issues) {
        const { source, route, issue } = issueDetail
        const descriptor = providerDescriptors.find((item) => item.source === source)
        const latestConfig = effectiveRoutes(current(), registrationSettings !== undefined)
        const latestProvider = descriptor === undefined ? undefined : latestConfig.providers[descriptor.key]
        if (generation !== refreshGeneration
          || refreshAbort.signal.aborted
          || descriptor === undefined
          || latestProvider?.enabled !== true
          || latestProvider.route !== route) continue
        const description = issue === 'missing'
          ? `${source} 的路由 ${route} 未激活；请在 DSH Models 中配置对应适配器和凭据`
          : `路由 ${route} 的模型目录不可用；继续保留 ${source} 上次验证通过的模型`
        warn(`route:${source}:${route}:${issue}`, description)
        failures.push({ provider: source, code: issue === 'missing' ? 'ENOENT' : 'UNKNOWN' })
      }
      if (generation === refreshGeneration && !refreshAbort.signal.aborted) {
        const observedTopology = providerTopologies(effectiveConfig, executable.models)
        const topology = new Map(lastTopology)
        for (const source of executable.observed) topology.set(source, observedTopology.get(source)!)
        if (isolationRefreshPending.size > 0) {
          for (const [source, intent] of [...isolationRefreshPending]) {
            if (!executable.observed.has(source)) continue
            const previousTopology = lastTopology.get(source)
            const currentTopology = topology.get(source)!
            if (intent === 'adapter') {
              if (previousTopology !== undefined) health.clearProvider(previousTopology.route)
              health.clearProvider(currentTopology.route)
            } else if (!sameTopology(previousTopology, currentTopology) && previousTopology !== undefined) {
              health.clearProvider(previousTopology.route)
              if (previousTopology.route !== currentTopology.route) health.clearProvider(currentTopology.route)
            }
            isolationRefreshPending.delete(source)
          }
        }
        candidates = mapOpenRouterToManagedRoute(
          catalog.executable(discovered, executable.models),
          config,
          registrationSettings !== undefined,
        )
        lastTopology = topology
        initialRefreshCompleted = true
        if (pendingManagedAdapterVerification !== undefined) pendingManagedAdapterVerification = undefined
        return complete()
      }
    } catch (error) {
      pendingManagedAdapterVerification = undefined
      failures.push({ provider: 'refresh', code: safeErrorCode(error) })
      if (!refreshAbort.signal.aborted) {
        logger.warn(`free-router: 模型目录刷新失败，继续使用已知候选（错误码：${safeErrorCode(error)}）`)
      }
      if (!refreshAbort.signal.aborted) return complete()
    }
  }
  const beginRefresh = (): void => {
    refreshInFlight = true
    const generation = refreshGeneration
    const verifying = pendingManagedAdapterVerification !== undefined
    const task = refresh(generation).catch((error: unknown) => {
      pendingReport = undefined
      pendingManagedAdapterVerification = undefined
      logger.warn(`free-router: 模型目录刷新失败，继续使用已知候选（错误码：${safeErrorCode(error)}）`)
      return createRefreshReport({
        startedAt: Date.now(), completedAt: Date.now(), discoveredModelIds: [], eligibleModelIds: [],
        previousModelIds: [], registeredModelIds: [], candidateCount: routableCandidates().length, registrationKind: 'skipped',
        failures: [{ provider: 'refresh', code: safeErrorCode(error) }],
      })
    }).then((report) => {
      if (report === undefined) return
      lastReport = report
      if (verifying && refreshWaiters.some((waiter) => waiter.requiresDiscovery)) void scheduleRefresh()
      for (let index = refreshWaiters.length - 1; index >= 0; index -= 1) {
        if (refreshWaiters[index].generation > generation || (verifying && refreshWaiters[index].requiresDiscovery)) continue
        refreshWaiters.splice(index, 1)[0].resolve(report)
      }
    })
    refreshTasks.add(task)
    const finish = (): void => {
      refreshTasks.delete(task)
      refreshInFlight = false
      if (refreshQueued && !refreshAbort.signal.aborted) {
        refreshQueued = false
        beginRefresh()
      }
    }
    void task.then(finish, finish)
  }
  const cancelledReport = (): RefreshReport => createRefreshReport({
    startedAt: Date.now(), completedAt: Date.now(), discoveredModelIds: [], eligibleModelIds: [],
    previousModelIds: [], registeredModelIds: [], registrationKind: 'skipped', failures: [{ provider: 'refresh', code: 'ABORT_ERR' }],
  })
  const scheduleRefresh = (intent?: IsolationRefreshIntent, verificationOnly = false): Promise<RefreshReport> => {
    if (refreshAbort.signal.aborted) return Promise.resolve(cancelledReport())
    if (intent !== undefined) {
      for (const { source } of providerDescriptors) {
        const previous = isolationRefreshPending.get(source)
        if (previous === undefined || intent === 'adapter') isolationRefreshPending.set(source, intent)
      }
    }
    refreshGeneration += 1
    const requiresDiscovery = pendingManagedAdapterVerification !== undefined && intent !== 'adapter' && !verificationOnly
    const result = new Promise<RefreshReport>((resolve) => refreshWaiters.push({ generation: refreshGeneration, requiresDiscovery, resolve }))
    if (refreshInFlight) {
      refreshQueued = true
      return result
    }
    beginRefresh()
    return result
  }
  triggerRefresh = () => scheduleRefresh()

  ctx.on('agent/request', (payload, next) => runtime.onRequest(payload, next), true)
  ctx.on('agent/request-error', (payload, next) => runtime.onRequestError(payload, next), true)
  ctx.on('llm/stream', (options, next) => runtime.observeStream(options, next))
  ctx.on('llm/adapters-updated', () => scheduleRefresh('adapter'))
  ctx.effect(() => {
    runtime.start()
    return () => runtime.dispose()
  }, 'free-router：健康监测生命周期')
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings as unknown as {
      configure?: (presentation: { auto: boolean }, owner: unknown) => (() => void) | void
      get?: (namespace: string) => unknown
      mutate?: RegistrationSettings['mutate']
      installSection?: (context: Context, namespace: string, schema: unknown, entry: RouterConfig, hooks: {
        setSource(source: () => unknown): void
        onChange(): void
      }) => void
    }
    if (typeof settings.get === 'function' && typeof settings.mutate === 'function') {
      registrationSettings = { get: settings.get.bind(settings), mutate: settings.mutate.bind(settings) }
    }
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, FREE_ROUTER_SETTINGS_NAMESPACE, ConfigSchema, current(), {
        setSource: (source) => {
          current = () => {
            lastValidConfig = parseConfig(source())
            return lastValidConfig
          }
        },
        onChange: () => scheduleRefresh('topology'),
      })
    } else if (typeof settings.configure === 'function') {
      ctx.effect(() => settings.configure!({ auto: false }, ctx.fiber) ?? (() => {}))
    }
    if (!initialRefreshScheduled) {
      initialRefreshScheduled = true
      scheduleRefresh()
    }
  })
  ctx.inject(['configEditor'], (editorCtx) => {
    if (registrationSettings === undefined) {
      registrationSettings = createConfigEditorRegistrationSettings(
        (editorCtx as unknown as { configEditor: ConfigEditor }).configEditor,
      )
    }
    if (!initialRefreshScheduled) {
      initialRefreshScheduled = true
      scheduleRefresh()
    }
  })
  ctx.inject(['commands'], (commandsCtx) => {
    try {
      registerFreeRouterCommands((commandsCtx as unknown as { commands: FreeRouterCommandRegistry }).commands, {
        refresh: () => scheduleRefresh(),
        status: () => lastReport,
      })
    } catch {
      warn('commands:registration', '会话命令注册失败')
    }
  })
  ctx.effect(() => async () => {
    refreshAbort.abort()
    for (const waiter of refreshWaiters.splice(0)) waiter.resolve(cancelledReport())
    await Promise.allSettled([...refreshTasks])
    await Promise.allSettled([...cacheTasks])
  }, 'free-router：取消模型目录刷新')
  queueMicrotask(() => {
    if (!initialRefreshScheduled && !refreshAbort.signal.aborted) {
      initialRefreshScheduled = true
      scheduleRefresh()
    }
  })
}
