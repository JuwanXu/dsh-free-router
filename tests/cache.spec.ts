import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HealthBook } from '../src/health.js'
import { FileRouterCache } from '../src/persistence/cache.js'
import { planManagedRoute } from '../src/registration/managed-route.js'

const record = {
  version: 2 as const,
  updatedAt: 1_000,
  candidates: [{
    provider: 'openrouter', model: 'free:free', displayName: 'Free', contextWindow: 65_536,
    toolCalling: true, free: true, tier: 'A', catalogUpdatedAt: 1_000,
  }],
  health: {},
  registrations: {},
}

const claim = {
  sourceRoute: 'openrouter',
  targetRoute: 'free-router-openrouter',
  profileSignature: 'a'.repeat(64),
  modelIds: ['first:free', 'second:free'],
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

  it('migrates a v1 cache with no claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    await writeFile(path, JSON.stringify({ ...record, version: 1, registrations: undefined }))

    await expect(cache.load(1_500)).resolves.toMatchObject({ version: 2, registrations: {} })
  })

  it('persists only a valid managed route claim without profile or secret fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)

    await cache.save({
      ...record,
      registrations: {
        openrouter: {
          ...claim,
          profile: { headers: { Authorization: 'Bearer sk-or-test-secret' } },
          apiKey: 'sk-or-test-secret',
        } as typeof claim,
      },
    })

    await expect(cache.load(1_500)).resolves.toMatchObject({ registrations: { openrouter: claim } })
    await expect(readFile(path, 'utf8')).resolves.not.toMatch(/Authorization|sk-or-test-secret/)
  })

  it('persists a hashed signature without source header values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const plan = planManagedRoute({
      headers: { Authorization: 'Bearer secret', 'X-Non-Sensitive': 'visible-header-value' },
    }, 'openrouter', { route: 'free-router-openrouter', displayName: 'Free Router · OpenRouter' }, [])

    await cache.save({ ...record, registrations: { openrouter: plan.claim } })

    expect(plan.claim.profileSignature).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(path, 'utf8')).resolves.not.toMatch(/Authorization|Bearer|secret|visible-header-value/)
  })

  it('downgrades a legacy plaintext v2 claim and strips it on the next save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const legacySignature = '{"profile":{"headers":{"Authorization":"Bearer old-cache-secret"}}}'
    await writeFile(path, JSON.stringify({
      ...record,
      registrations: { openrouter: { ...claim, profileSignature: legacySignature } },
    }))

    const loaded = await cache.load(1_500)
    expect(loaded?.version).toBe(2)
    expect(loaded?.registrations).toEqual({})
    await cache.save(loaded!)
    await expect(readFile(path, 'utf8')).resolves.not.toMatch(/Authorization|Bearer|old-cache-secret/)
  })

  it('rejects v2 records with invalid managed claims', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    await writeFile(path, JSON.stringify({
      ...record,
      registrations: { openrouter: claim },
    }))
    await expect(cache.load(1_500)).resolves.toMatchObject({ registrations: { openrouter: claim } })

    await writeFile(path, JSON.stringify({
      ...record,
      registrations: { openrouter: { ...claim, modelIds: ['first:free', 'first:free'] } },
    }))

    await expect(cache.load(1_500)).resolves.toBeUndefined()
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

  it('round-trips the last failure code used to distinguish isolation scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    await cache.save({
      ...record,
      health: {
        'openrouter/free:free': {
          status: 'unavailable', averageFirstByteMs: 100,
          successRate: 0.5, consecutiveFailures: 1, coolingUntil: 2_000,
          lastFailureCode: 'SERVER',
        },
      },
    })

    await expect(cache.load(1_500)).resolves.toMatchObject({
      health: { 'openrouter/free:free': { lastFailureCode: 'SERVER' } },
    })
  })

  it('keeps model cooldown separate from provider isolation across a cache round-trip', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const source = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    source.record('nvidia/a', { kind: 'failure', code: 'SERVER' }, 1_100)
    source.record('nvidia/b', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_000)
    source.record('nvidia/b', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_100)
    await cache.save({
      ...record,
      health: source.snapshots(['nvidia/a', 'nvidia/b'], 1_100),
    })
    const loaded = await cache.load(1_100)
    expect(loaded).toBeDefined()
    expect(loaded!.health['nvidia/a']?.recovery).toEqual({
      model: {
        status: 'unavailable', successRate: 0, consecutiveFailures: 1,
        coolingUntil: 1_200, lastFailureCode: 'SERVER',
      },
      provider: { coolingUntil: 1_300, failureCode: 'INVALID_CREDENTIAL' },
    })
    await expect(readFile(path, 'utf8')).resolves.not.toMatch(/modelCoolingUntil|providerCoolingUntil/)
    const restored = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    restored.restore(loaded!.health)

    restored.clearProvider('nvidia')

    expect(restored.isCooling('nvidia/a', 1_150)).toBe(true)
    expect(restored.isCooling('nvidia/a', 1_250)).toBe(false)
    expect(restored.isCooling('nvidia/b', 1_150)).toBe(false)
  })

  it('preserves one model own cooldown when clearing its restored provider isolation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const source = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    source.record('nvidia/a', { kind: 'failure', code: 'SERVER' }, 1_100)
    source.record('nvidia/a', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_100)
    await cache.save({
      ...record,
      health: source.snapshots(['nvidia/a'], 1_100),
    })
    const loaded = await cache.load(1_100)
    expect(loaded).toBeDefined()
    const restored = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    restored.restore(loaded!.health)

    restored.clearProvider('nvidia')

    expect(restored.isCooling('nvidia/a', 1_150)).toBe(true)
    expect(restored.isCooling('nvidia/a', 1_250)).toBe(false)
    expect(restored.snapshot('nvidia/a', 1_150)).toMatchObject({
      status: 'unavailable',
      consecutiveFailures: 1,
      lastFailureCode: 'SERVER',
    })
  })

  it('restores a healthy model status after sibling provider isolation expires', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 1_000)
    const source = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    source.record('nvidia/a', { kind: 'success', firstByteMs: 80 }, 900)
    source.record('nvidia/b', { kind: 'failure', code: 'INVALID_CREDENTIAL' }, 1_000)
    await cache.save({
      ...record,
      health: source.snapshots(['nvidia/a', 'nvidia/b'], 1_000),
    })
    const loaded = await cache.load(1_000)
    expect(loaded).toBeDefined()
    const restored = new HealthBook({ baseCooldownMs: 100, maxCooldownMs: 1_000, sampleSize: 5 })
    restored.restore(loaded!.health)

    expect(restored.snapshot('nvidia/a', 1_050).status).toBe('unavailable')
    expect(restored.snapshot('nvidia/a', 1_150)).toMatchObject({
      status: 'available',
      successRate: 1,
      averageFirstByteMs: 80,
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

  it('returns expired records only as health-ranking references and ignores malformed files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 10)
    await cache.save(record)

    await expect(cache.load(1_011)).resolves.toMatchObject({
      ...record,
      candidates: [],
      stale: true,
    })
    await writeFile(path, '{bad json')
    await expect(cache.load(1_001)).resolves.toBeUndefined()

    await writeFile(path, JSON.stringify({
      ...record,
      candidates: [null],
    }))
    await expect(cache.load(1_001)).resolves.toBeUndefined()
  })
})
