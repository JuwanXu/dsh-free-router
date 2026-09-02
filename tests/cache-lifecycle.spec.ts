import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.js'

describe('cache lifecycle', () => {
  const previousDshHome = process.env.DSH_HOME

  afterEach(() => {
    vi.doUnmock('node:fs/promises')
    vi.unstubAllGlobals()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('waits for an active cache write before plugin disposal completes', async () => {
    vi.resetModules()
    const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseWrite = resolve })
    const started = new Promise<void>((resolve) => { writeStarted = resolve })
    vi.doMock('node:fs/promises', () => ({
      ...originalFs,
      writeFile: async (...args: Parameters<typeof originalFs.writeFile>) => {
        writeStarted()
        await release
        return originalFs.writeFile(...args)
      },
    }))
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-test-${Date.now()}-cache-lifecycle`)
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'nvidia', name: 'NVIDIA NIM' }],
      listModels: async () => [
        { provider: 'nvidia', id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen' },
      ],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    const fiber = ctx.plugin(plugin, defaultConfig)
    await fiber
    await started

    const disposal = fiber.dispose()
    const outcome = await Promise.race([
      disposal.then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 25)),
    ])
    releaseWrite()
    await disposal

    expect(outcome).toBe('waiting')
  })
})
