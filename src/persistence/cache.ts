import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CandidateModel, HealthSnapshot } from '../types.js'

export interface RouterCacheRecord {
  version: 1
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
  /** In-memory marker: the record is usable only as a cold-start hint. */
  stale?: true
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
}

function isCacheRecord(value: unknown): value is RouterCacheRecord {
  if (!isRecord(value)) return false
  const candidate = value as Partial<RouterCacheRecord>
  return candidate.version === 1
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
    && Array.isArray(candidate.candidates)
    && candidate.candidates.every(isCandidate)
    && isRecord(candidate.health)
    && Object.values(candidate.health).every(isHealthSnapshot)
}

function normalizeHealthSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
  return {
    ...snapshot,
    averageFirstByteMs: snapshot.averageFirstByteMs === null
      ? Number.POSITIVE_INFINITY
      : snapshot.averageFirstByteMs,
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
      if (!isCacheRecord(parsed)) return undefined
      const record: RouterCacheRecord = {
        version: 1,
        updatedAt: parsed.updatedAt,
        candidates: parsed.candidates.map((candidate) => ({ ...candidate })),
        health: Object.fromEntries(Object.entries(parsed.health).map(([key, snapshot]) => [
          key,
          normalizeHealthSnapshot(snapshot),
        ])),
      }
      return now - record.updatedAt > this.ttlMs ? { ...record, stale: true } : record
    } catch {
      return undefined
    }
  }

  save(record: RouterCacheRecord): Promise<void> {
    const operation = this.writeTail.then(() => this.writeRecord(record))
    this.writeTail = operation.catch(() => {})
    return operation
  }

  private async writeRecord(record: RouterCacheRecord): Promise<void> {
    const safe: RouterCacheRecord = {
      version: 1,
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
      }])),
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(safe)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
