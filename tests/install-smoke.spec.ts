import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import manifest from '../package.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'

describe('installation bundle', () => {
  it('contains the plugin entrypoint, patch manifest, and public package metadata', async () => {
    const root = resolve(import.meta.dirname, '..')
    await Promise.all([
      access(resolve(root, 'dist', 'index.js')),
      access(resolve(root, manifest.dsh.bundle.patch)),
      access(resolve(root, 'README.md')),
      access(resolve(root, 'LICENSE')),
    ])
    await expect(readFile(resolve(root, manifest.dsh.bundle.patch), 'utf8')).resolves.toContain('free-router')
  })
})
