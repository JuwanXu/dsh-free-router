import { describe, expect, it, vi } from 'vitest'
import { registerFreeRouterCommands, type FreeRouterCommandInvocation, type FreeRouterCommandRegistry } from '../src/commands.js'
import { createRefreshReport, type RefreshReport } from '../src/refresh-report.js'

type Handler = (invocation: FreeRouterCommandInvocation) => Promise<{ kind: 'success' | 'error'; text: string }>

class FakeRegistry implements FreeRouterCommandRegistry {
  command?: { name: string; description: string; input: { hint: string }; handler: Handler }

  register(command: { name: string; description: string; input: { hint: string }; handler: Handler }): void {
    this.command = command
  }
}

function report(): RefreshReport {
  return createRefreshReport({
    startedAt: 100,
    completedAt: 150,
    discoveredModelIds: ['nvidia/a', 'openrouter/b'],
    eligibleModelIds: ['nvidia/a', 'openrouter/b'],
    candidateCount: 2,
    previousModelIds: ['nvidia/a', 'removed/c'],
    registrationKind: 'update',
    failures: [{ provider: 'openrouter', code: 'TIMEOUT' }],
  })
}

describe('free-router command boundary', () => {
  it('waits for refresh and prints public counts, registration, model changes and safe failures', async () => {
    const registry = new FakeRegistry()
    let finish!: (value: RefreshReport) => void
    const refresh = vi.fn(() => new Promise<RefreshReport>((resolve) => { finish = resolve }))
    registerFreeRouterCommands(registry, { refresh, status: () => undefined })
    expect(registry.command?.name).toBe('free-router')

    let settled = false
    const result = registry.command!.handler({ rawInput: 'refresh' }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    finish(report())
    const output = await result
    expect(output.kind).toBe('success')
    expect(output.text).toContain('discovered: 2')
    expect(output.text).toContain('eligible: 2')
    expect(output.text).toContain('candidates: 2')
    expect(output.text).toContain('registration: update')
    expect(output.text).toContain('added: openrouter/b')
    expect(output.text).toContain('removed: removed/c')
    expect(output.text).toContain('TIMEOUT')
  })

  it('shows status, empty state and usage without exposing sensitive report fields', async () => {
    const registry = new FakeRegistry()
    const last = report()
    registerFreeRouterCommands(registry, { refresh: async () => last, status: () => last })
    const command = registry.command!
    const invocation = (rawInput: string) => ({ rawInput })
    const status = await command.handler(invocation('status'))
    expect(status.text).toContain('discovered: 2')
    const sensitive = createRefreshReport({
      startedAt: 1,
      completedAt: 2,
      discoveredModelIds: [],
      eligibleModelIds: [],
      previousModelIds: [],
      registrationKind: 'none',
      registrationReason: 'Bearer secret reason',
      failures: [],
      sensitive: 'api-key-should-not-appear',
    } as Parameters<typeof createRefreshReport>[0])
    registerFreeRouterCommands(registry, { refresh: async () => sensitive, status: () => undefined })
    const empty = await registry.command!.handler(invocation('status'))
    expect(empty.text).toContain('no refresh report')
    const refreshResult = await registry.command!.handler(invocation('refresh'))
    expect(refreshResult.text).not.toContain('api-key-should-not-appear')
    expect(refreshResult.text).not.toContain('secret reason')
    const unknown = await registry.command!.handler(invocation('refresh now'))
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toBe('usage: /free-router refresh | status')
  })

  it('sanitizes unexpected failures', async () => {
    const registry = new FakeRegistry()
    registerFreeRouterCommands(registry, {
      refresh: async () => { throw new Error('secret token xyz') },
      status: () => undefined,
    })
    const output = await registry.command!.handler({ rawInput: 'refresh' })
    expect(output.kind).toBe('error')
    expect(output.text).not.toContain('secret token xyz')
  })

  it('sanitizes status failures instead of rejecting the handler promise', async () => {
    const registry = new FakeRegistry()
    registerFreeRouterCommands(registry, {
      refresh: async () => report(),
      status: () => { throw new Error('secret status token') },
    })
    const output = await registry.command!.handler({ rawInput: 'status' })
    expect(output.kind).toBe('error')
    expect(output.text).not.toContain('secret status token')
  })
})
