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
import { providerCatalogSources, providerConfig, providerDescriptors } from './providers.js'
import type { FreeRouterMetrics } from './events.js'
import './events.js'

export const name = 'free-router'
export const inject = ['llm']
export const Config = ConfigSchema
export { FREE_ROUTER_SETTINGS_NAMESPACE }
export type { RouterConfig }

const catalog = new CatalogRegistry(providerCatalogSources())

async function executableModels(
  ctx: Context,
  config: RouterConfig,
  previous: readonly CandidateModel[] = [],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const activeRoutes = new Set(ctx.llm.listProviders().map((provider) => provider.id))
  const result = new Map<string, ReadonlySet<string>>()
  await Promise.all(providerDescriptors.map(async ({ key, source }) => {
    const route = providerConfig(config, key).route
    if (!activeRoutes.has(route)) {
      result.set(source, new Set())
      return
    }
    try {
      const models = await ctx.llm.listModels(route)
      result.set(source, new Set(models.map((model) => model.id)))
    } catch {
      result.set(source, new Set(previous.filter((candidate) => candidate.provider === source).map((candidate) => candidate.model)))
    }
  }))
  return result
}

function routeCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const routes = new Map<string, string>(providerDescriptors.map(({ key, source }) => [source, providerConfig(config, key).route]))
  return candidates.map((candidate) => ({ ...candidate, provider: routes.get(candidate.provider) ?? candidate.provider }))
}

function sourceCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const sources = new Map<string, string>(providerDescriptors.map(({ key, source }) => [providerConfig(config, key).route, source]))
  return candidates.map((candidate) => ({ ...candidate, provider: sources.get(candidate.provider) ?? candidate.provider }))
}

/** Register request-level free-model routing on top of existing DSH LLM adapters. */
export function apply(ctx: Context, entry: RouterConfig): void {
  let current: () => RouterConfig = () => parseConfig(entry)
  let candidates: CandidateModel[] = []
  let refreshGeneration = 0
  let initialRefreshCompleted = false
  const refreshAbort = new AbortController()
  const logger = ctx.logger('free-router')
  const health = new HealthBook({ baseCooldownMs: 5_000, maxCooldownMs: 10 * 60_000, sampleSize: 20 })
  const cache = new FileRouterCache(dshHomePath('cache', 'free-router.json'), 24 * 60 * 60_000)
  const persistCache = (): void => {
    void cache.save({
      version: 1,
      updatedAt: Date.now(),
      candidates,
      health: health.snapshots(candidates.map(candidateKey), Date.now()),
    }).catch((error) => logger.warn(`free-router: cache save failed: ${String(error)}`))
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
      const executable = await executableModels(ctx, config, previous)
      const discovered = await catalog.refresh(executable, refreshAbort.signal, previous)
      if (generation === refreshGeneration && !refreshAbort.signal.aborted) {
        candidates = routeCatalogCandidates(discovered, config)
        initialRefreshCompleted = true
        persistCache()
        runtime.wake()
      }
    } catch (error) {
      if (!refreshAbort.signal.aborted) logger.warn(`free-router: model catalog refresh failed; keeping last known candidates: ${String(error)}`)
    }
  }
  triggerRefresh = () => { void refresh() }

  ctx.on('agent/request', (payload, next) => runtime.onRequest(payload, next), true)
  ctx.on('agent/request-error', (payload, next) => runtime.onRequestError(payload, next), true)
  ctx.on('llm/stream', (options, next) => runtime.observeStream(options, next))
  ctx.on('llm/adapters-updated', () => {
    const config = current()
    for (const { key } of providerDescriptors) health.clearProvider(providerConfig(config, key).route)
    triggerRefresh()
  })
  ctx.effect(() => () => refreshAbort.abort(), 'free-router: catalog refresh cancellation')
  ctx.effect(() => {
    runtime.start()
    return () => runtime.dispose()
  }, 'free-router: health monitoring lifecycle')
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, FREE_ROUTER_SETTINGS_NAMESPACE, ConfigSchema, current(), {
      setSource: (source) => {
        current = () => parseConfig(source())
      },
      onChange: () => { void refresh() },
    })
  })
  void cache.load(Date.now()).then((record) => {
    if (record === undefined || refreshAbort.signal.aborted || (record.stale === true && initialRefreshCompleted)) return
    health.restore(record.health, { stale: record.stale === true })
    if (initialRefreshCompleted) return
    const known = new Set(candidates.map(candidateKey))
    candidates = [...candidates, ...record.candidates.filter((candidate) => !known.has(candidateKey(candidate)))]
    runtime.wake()
  }).catch((error) => logger.warn(`free-router: cache load failed: ${String(error)}`))
  void refresh()
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
      metrics: serializableMetrics(event.metrics),
    })
  } catch (error) {
    logger.warn(`free-router: failed to append selection event: ${String(error)}`)
  }
}

function serializableMetrics(metrics: RouterSelectionEvent['metrics']): FreeRouterMetrics {
  return {
    ...metrics,
    averageFirstByteMs: Number.isFinite(metrics.averageFirstByteMs) ? metrics.averageFirstByteMs : null,
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
    logger.warn(`free-router: failed to append failover event: ${String(error)}`)
  }
}
