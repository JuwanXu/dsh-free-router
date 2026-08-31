import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CatalogRegistry } from './catalog/registry.js'
import { NvidiaCatalogSource } from './catalog/nvidia.js'
import { OpenRouterCatalogSource } from './catalog/openrouter.js'
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

export const name = 'free-router'
export const inject = ['llm']
export const Config = ConfigSchema
export { FREE_ROUTER_SETTINGS_NAMESPACE }
export type { RouterConfig }

const catalog = new CatalogRegistry([
  new NvidiaCatalogSource(),
  new OpenRouterCatalogSource(),
])

async function executableModels(ctx: Context, config: RouterConfig): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const routes = [
    ['openrouter', config.providers.openrouter.route],
    ['nvidia', config.providers.nvidia.route],
  ] as const
  const activeRoutes = new Set(ctx.llm.listProviders().map((provider) => provider.id))
  const result = new Map<string, ReadonlySet<string>>()
  await Promise.all(routes.map(async ([source, route]) => {
    if (!activeRoutes.has(route)) {
      result.set(source, new Set())
      return
    }
    const models = await ctx.llm.listModels(route)
    result.set(source, new Set(models.map((model) => model.id)))
  }))
  return result
}

function routeCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const routes: Record<string, string> = {
    openrouter: config.providers.openrouter.route,
    nvidia: config.providers.nvidia.route,
  }
  return candidates.map((candidate) => ({ ...candidate, provider: routes[candidate.provider] ?? candidate.provider }))
}

function sourceCatalogCandidates(candidates: readonly CandidateModel[], config: RouterConfig): CandidateModel[] {
  const sources: Record<string, string> = {
    [config.providers.openrouter.route]: 'openrouter',
    [config.providers.nvidia.route]: 'nvidia',
  }
  return candidates.map((candidate) => ({ ...candidate, provider: sources[candidate.provider] ?? candidate.provider }))
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
    onUnknownModel: () => triggerRefresh(),
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
      const executable = await executableModels(ctx, config)
      const discovered = await catalog.refresh(executable, refreshAbort.signal, sourceCatalogCandidates(candidates, config))
      if (generation === refreshGeneration && !refreshAbort.signal.aborted) {
        candidates = routeCatalogCandidates(discovered, config)
        initialRefreshCompleted = true
        persistCache()
      }
    } catch (error) {
      if (!refreshAbort.signal.aborted) logger.warn(`free-router: model catalog refresh failed; keeping last known candidates: ${String(error)}`)
    }
  }
  triggerRefresh = () => { void refresh() }

  ctx.on('agent/request', (payload, next) => runtime.onRequest(payload, next), true)
  ctx.on('agent/request-error', (payload, next) => runtime.onRequestError(payload, next), true)
  ctx.on('llm/stream', (options, next) => runtime.observeStream(options, next))
  ctx.on('llm/adapters-updated', triggerRefresh)
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
    if (record === undefined) return
    health.restore(record.health)
    if (initialRefreshCompleted) return
    const known = new Set(candidates.map(candidateKey))
    candidates = [...candidates, ...record.candidates.filter((candidate) => !known.has(candidateKey(candidate)))]
  })
  void refresh()
}
