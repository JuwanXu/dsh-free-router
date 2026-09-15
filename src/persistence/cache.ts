import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ManagedRouteClaim } from '../registration/types.js'
import type { CandidateModel, HealthRecoverySnapshot, HealthSnapshot } from '../types.js'

export interface RouterCacheRecord {
  version: 2
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
  registrations: {
    openrouter?: ManagedRouteClaim
  }
  /** 仅存在于内存中的标记：该记录只能作为冷启动排序参考。 */
  stale?: true
}

interface LegacyRouterCacheRecord {
  version: 1
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
}

interface V2CacheRecordInput {
  version: 2
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
  registrations: {
    openrouter?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCandidate(value: unknown): value is CandidateModel {
  if (!isRecord(value)) return false
  const contextWindow = value.contextWindow
  const catalogUpdatedAt = value.catalogUpdatedAt
  return typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && typeof value.displayName === 'string' && value.displayName.length > 0
    && typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
    && value.toolCalling === true
    && value.free === true
    && typeof value.tier === 'string' && value.tier.length > 0
    && typeof catalogUpdatedAt === 'number' && Number.isFinite(catalogUpdatedAt)
}

function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (!isRecord(value)) return false
  const average = value.averageFirstByteMs
  const consecutiveFailures = value.consecutiveFailures
  return (value.status === 'available' || value.status === 'unavailable' || value.status === 'unknown')
    && (average === null || (typeof average === 'number' && Number.isFinite(average) && average >= 0))
    && typeof value.successRate === 'number' && Number.isFinite(value.successRate)
    && value.successRate >= 0 && value.successRate <= 1
    && typeof consecutiveFailures === 'number' && Number.isInteger(consecutiveFailures) && consecutiveFailures >= 0
    && typeof value.coolingUntil === 'number' && Number.isFinite(value.coolingUntil) && value.coolingUntil >= 0
    && (value.lastFailureCode === undefined
      || (typeof value.lastFailureCode === 'string' && value.lastFailureCode.length > 0))
    && (value.recovery === undefined || isHealthRecoverySnapshot(value.recovery))
}

function isHealthRecoverySnapshot(value: unknown): value is HealthRecoverySnapshot {
  if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.provider)) return false
  const model = value.model
  const provider = value.provider
  return (model.status === 'available' || model.status === 'unavailable' || model.status === 'unknown')
    && typeof model.successRate === 'number' && Number.isFinite(model.successRate)
    && model.successRate >= 0 && model.successRate <= 1
    && typeof model.consecutiveFailures === 'number'
    && Number.isInteger(model.consecutiveFailures) && model.consecutiveFailures >= 0
    && validCoolingUntil(model.coolingUntil)
    && (model.lastFailureCode === undefined
      || (typeof model.lastFailureCode === 'string' && model.lastFailureCode.length > 0))
    && validCoolingUntil(provider.coolingUntil)
    && (provider.failureCode === undefined
      || (typeof provider.failureCode === 'string' && provider.failureCode.length > 0))
}

function validCoolingUntil(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function hasValidCacheContents(value: unknown): value is {
  version: unknown
  registrations?: unknown
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
} {
  if (!isRecord(value)) return false
  const candidate = value as Partial<RouterCacheRecord>
  return typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
    && Array.isArray(candidate.candidates)
    && candidate.candidates.every(isCandidate)
    && isRecord(candidate.health)
    && Object.values(candidate.health).every(isHealthSnapshot)
}

function hasManagedRouteClaimFields(value: unknown): value is Omit<ManagedRouteClaim, 'profileSignature'> & {
  profileSignature: string
} {
  if (!isRecord(value) || !Array.isArray(value.modelIds)) return false
  return typeof value.sourceRoute === 'string' && value.sourceRoute.length > 0
    && typeof value.targetRoute === 'string' && value.targetRoute.length > 0
    && typeof value.profileSignature === 'string'
    && value.modelIds.every((modelId) => typeof modelId === 'string' && modelId.length > 0)
    && new Set(value.modelIds).size === value.modelIds.length
}

function isManagedRouteClaim(value: unknown): value is ManagedRouteClaim {
  return hasManagedRouteClaimFields(value)
    && /^[a-f0-9]{64}$/.test(value.profileSignature)
}

function isLegacyCacheRecord(value: unknown): value is LegacyRouterCacheRecord {
  return hasValidCacheContents(value) && isRecord(value) && value.version === 1
}

function isCacheRecord(value: unknown): value is V2CacheRecordInput {
  if (!hasValidCacheContents(value) || !isRecord(value) || value.version !== 2 || !isRecord(value.registrations)) return false
  const registrations = value.registrations
  return Object.keys(registrations).every((key) => key === 'openrouter')
    && (registrations.openrouter === undefined || hasManagedRouteClaimFields(registrations.openrouter))
}

function copyManagedRouteClaim(claim: ManagedRouteClaim): ManagedRouteClaim {
  return {
    sourceRoute: claim.sourceRoute,
    targetRoute: claim.targetRoute,
    profileSignature: claim.profileSignature,
    modelIds: [...claim.modelIds],
  }
}

function normalizeHealthSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
  return {
    status: snapshot.status,
    averageFirstByteMs: snapshot.averageFirstByteMs === null
      ? Number.POSITIVE_INFINITY
      : snapshot.averageFirstByteMs,
    successRate: snapshot.successRate,
    consecutiveFailures: snapshot.consecutiveFailures,
    coolingUntil: snapshot.coolingUntil,
    ...(snapshot.lastFailureCode === undefined ? {} : { lastFailureCode: snapshot.lastFailureCode }),
    ...(snapshot.recovery === undefined ? {} : { recovery: copyRecoverySnapshot(snapshot.recovery) }),
  }
}

function copyRecoverySnapshot(recovery: HealthRecoverySnapshot): HealthRecoverySnapshot {
  return {
    model: {
      status: recovery.model.status,
      successRate: recovery.model.successRate,
      consecutiveFailures: recovery.model.consecutiveFailures,
      coolingUntil: recovery.model.coolingUntil,
      ...(recovery.model.lastFailureCode === undefined
        ? {}
        : { lastFailureCode: recovery.model.lastFailureCode }),
    },
    provider: {
      coolingUntil: recovery.provider.coolingUntil,
      ...(recovery.provider.failureCode === undefined
        ? {}
        : { failureCode: recovery.provider.failureCode }),
    },
  }
}

export class FileRouterCache {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly ttlMs: number,
  ) {}

  async load(now: number): Promise<RouterCacheRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!isLegacyCacheRecord(parsed) && !isCacheRecord(parsed)) return undefined
      const record: RouterCacheRecord = {
        version: 2,
        updatedAt: parsed.updatedAt,
        candidates: parsed.candidates.map((candidate) => ({ ...candidate })),
        health: Object.fromEntries(Object.entries(parsed.health).map(([key, snapshot]) => [
          key,
          normalizeHealthSnapshot(snapshot),
        ])),
        registrations: isCacheRecord(parsed) && isManagedRouteClaim(parsed.registrations.openrouter)
          ? { openrouter: copyManagedRouteClaim(parsed.registrations.openrouter) }
          : {},
      }
      return now - record.updatedAt > this.ttlMs
        ? { ...record, candidates: [], stale: true }
        : record
    } catch {
      return undefined
    }
  }

  save(record: RouterCacheRecord | LegacyRouterCacheRecord): Promise<void> {
    const operation = this.writeTail.then(() => this.writeRecord(record))
    this.writeTail = operation.catch(() => {})
    return operation
  }

  private async writeRecord(record: RouterCacheRecord | LegacyRouterCacheRecord): Promise<void> {
    const safe: RouterCacheRecord = {
      version: 2,
      updatedAt: record.updatedAt,
      candidates: record.candidates.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        displayName: candidate.displayName,
        contextWindow: candidate.contextWindow,
        toolCalling: candidate.toolCalling,
        free: candidate.free,
        tier: candidate.tier,
        catalogUpdatedAt: candidate.catalogUpdatedAt,
      })),
      health: Object.fromEntries(Object.entries(record.health).map(([key, snapshot]) => [key, {
        status: snapshot.status,
        averageFirstByteMs: snapshot.averageFirstByteMs,
        successRate: snapshot.successRate,
        consecutiveFailures: snapshot.consecutiveFailures,
        coolingUntil: snapshot.coolingUntil,
        ...(snapshot.lastFailureCode === undefined ? {} : { lastFailureCode: snapshot.lastFailureCode }),
        ...(snapshot.recovery === undefined ? {} : { recovery: copyRecoverySnapshot(snapshot.recovery) }),
      }])),
      registrations: record.version === 2 && isManagedRouteClaim(record.registrations.openrouter)
        ? { openrouter: copyManagedRouteClaim(record.registrations.openrouter) }
        : {},
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(safe)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
