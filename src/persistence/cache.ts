import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CandidateModel, HealthSnapshot } from '../types.js'

export interface RouterCacheRecord {
  version: 1
  updatedAt: number
  candidates: CandidateModel[]
  health: Record<string, HealthSnapshot>
}

function isCacheRecord(value: unknown): value is RouterCacheRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RouterCacheRecord>
  return candidate.version === 1
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
    && Array.isArray(candidate.candidates)
    && !!candidate.health
    && typeof candidate.health === 'object'
}

export class FileRouterCache {
  constructor(
    private readonly path: string,
    private readonly ttlMs: number,
  ) {}

  async load(now: number): Promise<RouterCacheRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!isCacheRecord(parsed) || now - parsed.updatedAt > this.ttlMs) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  async save(record: RouterCacheRecord): Promise<void> {
    const safe: RouterCacheRecord = {
      version: 1,
      updatedAt: record.updatedAt,
      candidates: record.candidates.map((candidate) => ({ ...candidate })),
      health: Object.fromEntries(Object.entries(record.health).map(([key, snapshot]) => [key, { ...snapshot }])),
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(safe)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
