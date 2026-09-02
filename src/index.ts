import type { Context, Logger } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CatalogRegistry } from './catalog/registry.js'
import {
  Config as ConfigSchema,
  FREE_ROUTER_SETTINGS_NAMESPACE,
  parseConfig,
  type RouterConfig,
} from './config.js'
import { HealthBook } from './health.js'
import { FileRouterCache } from './persistence/cache.js'
import { createRouterRuntime } from './runtime/router.js'
import { candidateKey, type CandidateModel } from './types.js'
import type { RouterFailoverEvent, RouterSelectionEvent } from './runtime/router.js'
import { providerCatalogSources, providerDescriptors } from './providers.js'
import { toFreeRouterMetrics } from './events.js'
import './events.js'

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

function routeCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const routes = new Map<string, string>(providerDescriptors.map(({ key, source }) => [source, config.providers[key].route]))
  return candidates.map((candidate) => ({ ...candidate, provider: routes.get(candidate.provider) ?? candidate.provider }))
}

function sourceCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const sources = new Map<string, string>(providerDescriptors.map(({ key, source }) => [config.providers[key].route, source]))
  return candidates.map((candidate) => ({ ...candidate, provider: sources.get(candidate.provider) ?? candidate.provider }))
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
  let current: () => RouterConfig = () => parseConfig(entry)
  let candidates: CandidateModel[] = []
  let refreshGeneration = 0
  const isolationRefreshPending = new Map<string, IsolationRefreshIntent>()
  let initialRefreshCompleted = false
  let lastTopology = new Map<string, ProviderTopology>()
  const refreshAbort = new AbortController()
  const refreshTasks = new Set<Promise<void>>()
  const cacheTasks = new Set<Promise<void>>()
  const logger = ctx.logger('free-router')
  const warn = createThrottledWarning(logger)
  const catalog = new CatalogRegistry(providerCatalogSources())
  const health = new HealthBook({ baseCooldownMs: 5_000, maxCooldownMs: 10 * 60_000, sampleSize: 20 })
  const cache = new FileRouterCache(dshHomePath('cache', 'free-router.json'), 24 * 60 * 60_000)
  const persistCache = (): void => {
    if (refreshAbort.signal.aborted) return
    const task = cache.save({
      version: 1,
      updatedAt: Date.now(),
      candidates,
      health: health.snapshots(candidates.map(candidateKey), Date.now()),
    }).catch((error) => logger.warn(`free-router: 缓存保存失败（错误码：${safeErrorCode(error)}）`))
    cacheTasks.add(task)
    void task.then(
      () => cacheTasks.delete(task),
      () => cacheTasks.delete(task),
    )
  }
  let triggerRefresh: () => void = () => {}
  const runtime = createRouterRuntime({
    getConfig: () => current(),
    getCandidates: () => candidates,
    health,
    onHealthChange: persistCache,
    onUnknownModel: (unknown) => {
      const unknownKey = candidateKey(unknown)
      candidates = candidates.filter((candidate) => candidateKey(candidate) !== unknownKey)
      persistCache()
      triggerRefresh()
    },
    onSelected: (event) => appendSelectionEvent(event, logger),
    onFailover: (event) => appendFailoverEvent(event, logger),
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

  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    const config = current()
    try {
      const previous = sourceCatalogCandidates(candidates, config)
      const executable = await executableModels(
        ctx,
        config,
        previous,
        refreshAbort.signal,
        config.health.timeoutMs,
      )
      for (const { source, route, issue } of executable.issues) {
        const descriptor = providerDescriptors.find((item) => item.source === source)
        const latestProvider = descriptor === undefined ? undefined : current().providers[descriptor.key]
        if (generation !== refreshGeneration
          || refreshAbort.signal.aborted
          || latestProvider?.enabled !== true
          || latestProvider.route !== route) continue
        const description = issue === 'missing'
          ? `${source} 的路由 ${route} 未激活；请在 DSH Models 中配置对应适配器和凭据`
          : `路由 ${route} 的模型目录不可用；继续保留 ${source} 上次验证通过的模型`
        warn(`route:${source}:${route}:${issue}`, description)
      }
      const discovered = await catalog.refresh(executable.models, refreshAbort.signal, previous, (provider) => {
        const descriptor = providerDescriptors.find(({ source }) => source === provider)
        if (generation !== refreshGeneration
          || refreshAbort.signal.aborted
          || descriptor === undefined
          || !current().providers[descriptor.key].enabled) return
        warn(`catalog:${provider}`, `${provider} 模型目录刷新失败；继续保留上次验证通过的快照`)
      })
      if (generation === refreshGeneration && !refreshAbort.signal.aborted) {
        const observedTopology = providerTopologies(config, executable.models)
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
        candidates = routeCatalogCandidates(discovered, config)
        lastTopology = topology
        initialRefreshCompleted = true
        persistCache()
        runtime.wake()
      }
    } catch (error) {
      if (!refreshAbort.signal.aborted) {
        logger.warn(`free-router: 模型目录刷新失败，继续使用已知候选（错误码：${safeErrorCode(error)}）`)
      }
    }
  }
  const scheduleRefresh = (intent?: IsolationRefreshIntent): void => {
    if (intent !== undefined) {
      for (const { source } of providerDescriptors) {
        const previous = isolationRefreshPending.get(source)
        if (previous === undefined || intent === 'adapter') isolationRefreshPending.set(source, intent)
      }
    }
    const task = refresh()
    refreshTasks.add(task)
    void task.then(
      () => refreshTasks.delete(task),
      () => refreshTasks.delete(task),
    )
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
    settingsCtx.settings.installSection(ctx, FREE_ROUTER_SETTINGS_NAMESPACE, ConfigSchema, current(), {
      setSource: (source) => {
        current = () => parseConfig(source())
      },
      onChange: () => scheduleRefresh('topology'),
    })
  })
  ctx.effect(() => async () => {
    refreshAbort.abort()
    await Promise.allSettled([...refreshTasks])
    await Promise.allSettled([...cacheTasks])
  }, 'free-router：取消模型目录刷新')
  void cache.load(Date.now()).then((record) => {
    if (record === undefined || refreshAbort.signal.aborted || (record.stale === true && initialRefreshCompleted)) return
    health.restore(record.health, { stale: record.stale === true })
    if (initialRefreshCompleted) return
    const known = new Set(candidates.map(candidateKey))
    candidates = [...candidates, ...record.candidates.filter((candidate) => !known.has(candidateKey(candidate)))]
    runtime.wake()
  }).catch((error) => {
    if (!refreshAbort.signal.aborted) logger.warn(`free-router: 缓存加载失败（错误码：${safeErrorCode(error)}）`)
  })
  scheduleRefresh()
}

function appendSelectionEvent(event: RouterSelectionEvent, logger: Logger): void {
  const session = (event.agent as { session?: Session }).session
  if (session === undefined) return
  try {
    session.append('free-router/selected', {
      turn: event.turn,
      step: event.step,
      attempt: event.attempt,
      provider: event.candidate.provider,
      model: event.candidate.model,
      reason: event.reason,
      metrics: toFreeRouterMetrics(event.metrics),
    })
  } catch (error) {
    logger.warn(`free-router: 追加选路事件失败（错误码：${safeErrorCode(error)}）`)
  }
}

function appendFailoverEvent(event: RouterFailoverEvent, logger: Logger): void {
  const session = (event.agent as { session?: Session }).session
  if (session === undefined) return
  try {
    session.append('free-router/failover', {
      turn: event.turn,
      step: event.step,
      attempt: event.attempt,
      provider: event.failedCandidate.provider,
      model: event.failedCandidate.model,
      failureCode: event.failureCode,
      isolatedScope: event.isolatedScope,
      nextProvider: event.nextCandidate.provider,
      nextModel: event.nextCandidate.model,
      attempts: event.attempts,
    })
  } catch (error) {
    logger.warn(`free-router: 追加故障转移事件失败（错误码：${safeErrorCode(error)}）`)
  }
}
