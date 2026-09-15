import { createHash } from 'node:crypto'
import type { CandidateModel } from '../types.js'
import type { ManagedRoutePlan, ManagedRouteRegistration } from './types.js'

const COPIED_PROFILE_FIELDS = [
  'apiKeyEnv', 'api', 'baseURL', 'headers', 'retryPolicy', 'compat',
  'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning',
  'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs',
  'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes',
  'requestImagePixelBudget', 'requestImageMaxBytes',
] as const

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
])

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copyJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyJson(item)).filter((item): item is JsonValue => item !== undefined)
  }
  if (isRecord(value)) {
    const copy = Object.create(null) as Record<string, JsonValue>
    for (const key of Object.keys(value)) {
      const item = copyJson(value[key])
      if (item !== undefined) Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      })
    }
    return copy
  }
  return undefined
}

function copyHeaders(value: unknown): JsonValue | undefined {
  if (!isRecord(value)) return copyJson(value)
  const headers = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(value)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) continue
    const item = copyJson(value[key])
    if (item === undefined) continue
    Object.defineProperty(headers, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    })
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted = Object.create(null) as Record<string, JsonValue>
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(sorted, key, {
        configurable: true,
        enumerable: true,
        value: sortKeys(value[key]),
        writable: true,
      })
    }
    return sorted
  }
  return value
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value))
}

export function planManagedRoute(
  sourceProfile: Record<string, unknown>,
  sourceRoute: string,
  registration: ManagedRouteRegistration,
  candidates: readonly CandidateModel[],
): ManagedRoutePlan {
  const profile: Record<string, unknown> = {}
  for (const field of COPIED_PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(sourceProfile, field)) continue
    const value = field === 'headers' ? copyHeaders(sourceProfile[field]) : copyJson(sourceProfile[field])
    if (value !== undefined) profile[field] = value
  }

  const modelsById = new Map<string, { id: string; name: string; contextWindow: number }>()
  for (const candidate of candidates) {
    const model = { id: candidate.model, name: candidate.displayName, contextWindow: candidate.contextWindow }
    const previous = modelsById.get(model.id)
    if (previous === undefined || `${model.name}\u0000${model.contextWindow}` < `${previous.name}\u0000${previous.contextWindow}`) {
      modelsById.set(model.id, model)
    }
  }
  const models = [...modelsById.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  profile.displayName = registration.displayName
  profile.models = models

  const staticProfile = { ...profile }
  delete staticProfile.models
  const profileSignature = createHash('sha256').update(canonicalJson({
    sourceRoute,
    targetRoute: registration.route,
    profile: staticProfile as { [key: string]: JsonValue },
  })).digest('hex')
  return {
    targetRoute: registration.route,
    profile,
    claim: {
      sourceRoute,
      targetRoute: registration.route,
      profileSignature,
      modelIds: models.map(({ id }) => id),
    },
  }
}
