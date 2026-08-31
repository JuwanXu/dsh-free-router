import manifest from '../package.json' with { type: 'json' }
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package manifest', () => {
  it('declares an installable DSH bundle', () => {
    expect(manifest.type).toBe('module')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['.'].default).toBe('./dist/index.js')
  })

  it('publishes the entry path declared in its manifest', async () => {
    await access(resolve(import.meta.dirname, '..', 'dist', 'index.js'))
  })
})
