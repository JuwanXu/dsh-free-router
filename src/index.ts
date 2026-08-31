import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
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
import { createRouterRuntime } from './runtime/router.js'
import type { CandidateModel } from './types.js'

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

/** Register request-level free-model routing on top of existing DSH LLM adapters. */
export function apply(ctx: Context, entry: RouterConfig): void {
  let current: () => RouterConfig = () => parseConfig(entry)
  let candidates: CandidateModel[] = []
  let refreshGeneration = 0
  const refreshAbort = new AbortController()
  const logger = ctx.logger('free-router')
  const health = new HealthBook({ baseCooldownMs: 5_000, maxCooldownMs: 10 * 60_000, sampleSize: 20 })
  const runtime = createRouterRuntime({
    getConfig: () => current(),
    getCandidates: () => candidates,
    health,
  })

  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    const config = current()
    try {
      const executable = await executableModels(ctx, config)
      const discovered = await catalog.refresh(executable, refreshAbort.signal)
      if (generation === refreshGeneration && !refreshAbort.signal.aborted) {
        candidates = routeCatalogCandidates(discovered, config)
      }
    } catch (error) {
      if (!refreshAbort.signal.aborted) logger.warn(`free-router: model catalog refresh failed; keeping last known candidates: ${String(error)}`)
    }
  }

  ctx.on('agent/request', (payload, next) => runtime.onRequest(payload, next), true)
  ctx.on('agent/request-error', (payload, next) => runtime.onRequestError(payload, next), true)
  ctx.on('llm/adapters-updated', () => { void refresh() })
  ctx.effect(() => () => refreshAbort.abort(), 'free-router: catalog refresh cancellation')
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, FREE_ROUTER_SETTINGS_NAMESPACE, ConfigSchema, current(), {
      setSource: (source) => {
        current = () => parseConfig(source())
      },
      onChange: () => { void refresh() },
    })
  })
  void refresh()
}
