import manifest from '../package.json' with { type: 'json' }
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package manifest', () => {
  it('prepares the 0.1.4 package with the command module and both README files', () => {
    expect(manifest.version).toBe('0.1.4')
    expect(manifest.files).toContain('README.md')
    expect(manifest.files).toContain('docs/README.zh-CN.md')
  })

  it('declares an installable DSH bundle', () => {
    expect(manifest.type).toBe('module')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['.'].default).toBe('./dist/index.js')
  })

  it('publishes the entry path declared in its manifest', async () => {
    const entryPath = resolve(import.meta.dirname, '..', 'dist', 'index.js')
    await access(entryPath)
    const entry = await readFile(entryPath, 'utf8')
    expect(entry).toContain('usage: /free-router refresh | status')
    expect(entry).toContain('refresh and inspect free-router model discovery')
  })

  it('documents dynamic OpenRouter registration', async () => {
    const readme = await readFile(resolve(import.meta.dirname, '..', 'README.md'), 'utf8')
    expect(readme).toContain('free-router-openrouter')
    expect(readme).toContain('registration:')
  })
})
