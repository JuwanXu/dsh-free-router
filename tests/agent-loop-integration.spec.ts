import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.js'

const qwen = 'qwen/qwen3-coder-480b-a35b-instruct'
const deepseek = 'deepseek-ai/deepseek-v3.2'

class FailoverAdapter extends LlmAdapter {
  readonly calls: string[] = []

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [qwen, deepseek].map((id) => ({ provider, id, name: id }))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.calls.push(options.model)
    if (options.model === qwen) {
      yield { type: 'text-delta', index: 0, text: 'failed-prefix' }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'retry elsewhere' } },
      }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function waitForCatalog(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Agent Loop integration', () => {
  const previousDshHome = process.env.DSH_HOME

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('routes and fails over a real Agent Loop turn', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    process.env.DSH_HOME = join(tmpdir(), `dsh-free-router-agent-loop-${Date.now()}`)
    vi.resetModules()
    const freeRouter = await import('../src/index.js')
    const ctx = new Context()
    const llmFiber = ctx.plugin(LlmRuntime)
    await llmFiber

    const adapter = new FailoverAdapter()
    const unregisterAdapter = ctx.llm.registerAdapter(['nvidia'], adapter)
    const serviceFibers = [
      ctx.plugin(SessionStore),
      ctx.plugin(SessionProjectionRegistry),
      ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }),
      ctx.plugin(ToolRuntime, {}),
      ctx.plugin(AgentRegistry),
    ]
    const routerFiber = ctx.plugin(freeRouter, defaultConfig)
    const loopFiber = ctx.plugin(AgentLoop, { agents: [] })
    let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined

    try {
      await Promise.all([...serviceFibers, routerFiber, loopFiber])
      await waitForCatalog()
      handle = await ctx.agents.create({
        sessionId: 'free-router-agent-loop' as SessionId,
        agentOptions: { provider: 'openrouter', model: 'user-selected' },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()

      expect(adapter.calls).toEqual([qwen, deepseek])
      expect(handle.agent.session.events
        .map((event) => event.type)
        .filter((type) => type.startsWith('free-router/')))
        .toEqual([])
      const assistantHistory = handle.agent.session.deriveMessages()
        .filter((message) => message.role === 'assistant')
      expect(assistantHistory).toHaveLength(1)
      expect(assistantHistory[0]?.source).toMatchObject({
        kind: 'model', provider: 'nvidia', model: deepseek,
      })
      expect(JSON.stringify(assistantHistory)).toContain('done')
      expect(JSON.stringify(assistantHistory)).not.toContain('failed-prefix')
    } finally {
      await handle?.dispose()
      await loopFiber.dispose()
      await routerFiber.dispose()
      unregisterAdapter()
      await Promise.allSettled([...serviceFibers].reverse().map((fiber) => fiber.dispose()))
      await llmFiber.dispose()
    }
  })
})
