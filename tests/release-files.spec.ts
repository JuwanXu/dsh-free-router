import manifest from '../package.json' with { type: 'json' }
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

  it('ships user documentation but excludes internal planning records', () => {
    const packageFiles = manifest.files as string[]
    const isInternalPlanningPath = (file: string): boolean => /(?:^|\/)docs\/superpowers\//.test(file)

    expect(packageFiles).toContain('docs/README.zh-CN.md')
    expect(isInternalPlanningPath('docs/superpowers/plan.md')).toBe(true)
    expect(isInternalPlanningPath('/docs/superpowers/plan.md')).toBe(true)
    expect(packageFiles.some(isInternalPlanningPath)).toBe(false)
  })

  it('documents the 0.1.3 desktop release gate for the author', async () => {
    const root = resolve(import.meta.dirname, '..')
    const checklist = await readFile(resolve(root, 'docs', 'release-checklist.md'), 'utf8')
    expect(checklist).toContain('allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk')
    expect(checklist).toContain('npm publish')
    for (const file of ['README.md', 'docs/README.zh-CN.md', 'docs/release-checklist.md']) {
      const content = await readFile(resolve(root, file), 'utf8')
      expect(content.indexOf('allow-version dsh-free-router@0.1.3')).toBeLessThan(content.indexOf('add file:/absolute/path/dsh-free-router-0.1.3.tgz'))
    }
  })
})
