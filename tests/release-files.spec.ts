import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release files', () => {
  it('defines the Node 22 validation workflow and local release checklist', async () => {
    const root = resolve(import.meta.dirname, '..')
    const workflow = await readFile(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(workflow).toContain('node-version: 22')
    expect(workflow).toContain('pnpm run check')
    await access(resolve(root, 'docs', 'release-checklist.md'))
    await access(resolve(root, 'LICENSE'))
  })
})
