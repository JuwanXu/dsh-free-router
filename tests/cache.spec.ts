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

  it('ignores expired and malformed files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-free-router-'))
    const path = join(directory, 'router.json')
    const cache = new FileRouterCache(path, 10)
    await cache.save(record)

    await expect(cache.load(1_011)).resolves.toBeUndefined()
    await writeFile(path, '{bad json')
    await expect(cache.load(1_001)).resolves.toBeUndefined()
  })
})
