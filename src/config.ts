import z from '@deepseek-ai/schemastery'
import { providerDescriptors } from './providers.js'
import type { ModelTier } from './types.js'

export const FREE_ROUTER_SETTINGS_NAMESPACE = 'free-router'

export interface ProviderConfig {
  enabled: boolean
  route: string
}

export interface RouterConfig {
  enabled: boolean
  providers: {
    openrouter: ProviderConfig
    nvidia: ProviderConfig
  }
  routing: {
    maxAttemptsPerStep: number
    minimumContextWindow: number
    minimumTier: ModelTier
    includeModels: string[]
    excludeModels: string[]
  }
  health: {
    timeoutMs: number
    concurrency: number
    activeProbeIntervalMs: number
    idleProbeIntervalMs: number
    maxCandidatesPerProvider: number
  }
}

export const defaultConfig: RouterConfig = {
  enabled: true,
  providers: {
    openrouter: { enabled: true, route: 'openrouter' },
    nvidia: { enabled: true, route: 'nvidia' },
  },
  routing: {
    maxAttemptsPerStep: 4,
    minimumContextWindow: 32_768,
    minimumTier: 'B',
    includeModels: [],
    excludeModels: [],
  },
  health: {
    timeoutMs: 6_000,
    concurrency: 4,
    activeProbeIntervalMs: 60_000,
    idleProbeIntervalMs: 600_000,
    maxCandidatesPerProvider: 8,
  },
}

const tiers: ModelTier[] = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C', '?']
const providerKeys = new Set(providerDescriptors.map(({ key }) => key))

/** DSH Settings schema, including defaults so an empty user section is usable. */
export const Config: z<RouterConfig> = z.object({
  enabled: z.boolean().default(defaultConfig.enabled),
  providers: z.object({
    openrouter: z.object({
      enabled: z.boolean().default(defaultConfig.providers.openrouter.enabled),
      route: z.string().min(1).default(defaultConfig.providers.openrouter.route),
    }).default(defaultConfig.providers.openrouter),
    nvidia: z.object({
      enabled: z.boolean().default(defaultConfig.providers.nvidia.enabled),
      route: z.string().min(1).default(defaultConfig.providers.nvidia.route),
    }).default(defaultConfig.providers.nvidia),
  }).default(defaultConfig.providers),
  routing: z.object({
    maxAttemptsPerStep: z.number().step(1).min(1).max(32).default(defaultConfig.routing.maxAttemptsPerStep),
    minimumContextWindow: z.number().step(1).min(1).default(defaultConfig.routing.minimumContextWindow),
    minimumTier: z.union(tiers).default(defaultConfig.routing.minimumTier),
    includeModels: z.array(z.string().min(1)).default(defaultConfig.routing.includeModels),
    excludeModels: z.array(z.string().min(1)).default(defaultConfig.routing.excludeModels),
  }).default(defaultConfig.routing),
  health: z.object({
    timeoutMs: z.number().step(1).min(1).default(defaultConfig.health.timeoutMs),
    concurrency: z.number().step(1).min(1).max(16).default(defaultConfig.health.concurrency),
    activeProbeIntervalMs: z.number().step(1).min(1).default(defaultConfig.health.activeProbeIntervalMs),
    idleProbeIntervalMs: z.number().step(1).min(1).default(defaultConfig.health.idleProbeIntervalMs),
    maxCandidatesPerProvider: z.number().step(1).min(1).max(32).default(defaultConfig.health.maxCandidatesPerProvider),
  }).default(defaultConfig.health),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeRecord<T extends object>(base: T, value: unknown, label: string): T {
  if (value === undefined) return { ...base }
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return { ...base, ...value } as T
}

function validateNumber(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${label} must be a list of non-empty strings`)
  }
  return [...value]
}

/** Parse an entry config without relying on Settings to be installed. */
export function parseConfig(value: unknown): RouterConfig {
  if (!isRecord(value)) throw new TypeError('free-router config must be an object')
  const unknownTopLevel = Object.keys(value).filter((key) => !['enabled', 'providers', 'routing', 'health'].includes(key))
  if (unknownTopLevel.length > 0) throw new TypeError(`unknown config fields: ${unknownTopLevel.join(', ')}`)

  const providersInput = mergeRecord(defaultConfig.providers, value.providers, 'providers')
  const unknownProviders = Object.keys(providersInput).filter((key) => !providerKeys.has(key as typeof providerDescriptors[number]['key']))
  if (unknownProviders.length > 0) throw new TypeError(`unknown providers: ${unknownProviders.join(', ')}`)
  const readProvider = (name: 'openrouter' | 'nvidia'): ProviderConfig => {
    const input = mergeRecord(defaultConfig.providers[name], providersInput[name], `providers.${name}`)
    if (typeof input.enabled !== 'boolean' || typeof input.route !== 'string' || input.route.length === 0) {
      throw new TypeError(`providers.${name} must contain enabled and route`)
    }
    return { enabled: input.enabled, route: input.route }
  }

  const routingInput = mergeRecord(defaultConfig.routing, value.routing, 'routing')
  const healthInput = mergeRecord(defaultConfig.health, value.health, 'health')
  if (typeof value.enabled !== 'undefined' && typeof value.enabled !== 'boolean') throw new TypeError('enabled must be boolean')
  if (!tiers.includes(routingInput.minimumTier as ModelTier)) throw new TypeError('routing.minimumTier is invalid')

  return {
    enabled: value.enabled ?? defaultConfig.enabled,
    providers: { openrouter: readProvider('openrouter'), nvidia: readProvider('nvidia') },
    routing: {
      maxAttemptsPerStep: validateNumber(routingInput.maxAttemptsPerStep, 'routing.maxAttemptsPerStep', 1, 32),
      minimumContextWindow: validateNumber(routingInput.minimumContextWindow, 'routing.minimumContextWindow', 1),
      minimumTier: routingInput.minimumTier as ModelTier,
      includeModels: validateStringList(routingInput.includeModels, 'routing.includeModels'),
      excludeModels: validateStringList(routingInput.excludeModels, 'routing.excludeModels'),
    },
    health: {
      timeoutMs: validateNumber(healthInput.timeoutMs, 'health.timeoutMs', 1),
      concurrency: validateNumber(healthInput.concurrency, 'health.concurrency', 1, 16),
      activeProbeIntervalMs: validateNumber(healthInput.activeProbeIntervalMs, 'health.activeProbeIntervalMs', 1),
      idleProbeIntervalMs: validateNumber(healthInput.idleProbeIntervalMs, 'health.idleProbeIntervalMs', 1),
      maxCandidatesPerProvider: validateNumber(healthInput.maxCandidatesPerProvider, 'health.maxCandidatesPerProvider', 1, 32),
    },
  }
}
