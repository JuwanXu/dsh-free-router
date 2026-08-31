import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRouterCache } from '../src/persistence/cache.js'

const record = {
  version: 1 as const,
  updatedAt: 1_000,
  candidates: [{
    provider: 'openrouter', model: 'free:free', displayName: 'Free', contextWindow: 65_536,
    toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 1_000,
  }],
  health: {},
}

describe('FileRouterCache', () => {
  it('persists only the versioned routing record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)

    await cache.save(record)

    await expect(cache.load(1_500)).resolves.toEqual(record)
    await expect(readFile(path, 'utf8')).resolves.not.toContain('Authorization')
  })

  it('drops unexpected properties so credentials cannot reach the cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const unsafe = {
      ...record,
      candidates: [{ ...record.candidates[0], apiKey: 'sk-or-test-secret' }],
      health: { 'openrouter/free:free': { ...record.health, authorization: 'Bearer secret' } },
    }

    await cache.save(unsafe as typeof record)
    await expect(readFile(path, 'utf8')).resolves.not.toMatch(/sk-or-test-secret|Bearer secret/)
  })

  it('round-trips an unknown latency through JSON null', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    await cache.save({
      ...record,
      health: {
        'openrouter/free:free': {
          status: 'unknown', averageFirstByteMs: Number.POSITIVE_INFINITY,
          successRate: 0, consecutiveFailures: 0, coolingUntil: 0,
        },
      },
    })

    await expect(cache.load(1_500)).resolves.toMatchObject({
      health: { 'openrouter/free:free': { averageFirstByteMs: Number.POSITIVE_INFINITY } },
    })
  })

  it('serializes concurrent atomic writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)

    await Promise.all([
      cache.save(record),
      cache.save({ ...record, updatedAt: 1_001 }),
    ])

    await expect(cache.load(1_001)).resolves.toMatchObject({ updatedAt: 1_001 })
  })

  it('returns expired records as stale cold-start references and ignores malformed files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 10)
    await cache.save(record)

    await expect(cache.load(1_011)).resolves.toMatchObject({ ...record, stale: true })
    await writeFile(path, '{bad json')
    await expect(cache.load(1_001)).resolves.toBeUndefined()

    await writeFile(path, JSON.stringify({
      ...record,
      candidates: [null],
    }))
    await expect(cache.load(1_001)).resolves.toBeUndefined()
  })
})
