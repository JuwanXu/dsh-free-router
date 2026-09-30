import type { RefreshReport } from './refresh-report.js'

export interface FreeRouterCommandView {
  refresh(): Promise<RefreshReport>
  status(): RefreshReport | undefined
}

export interface FreeRouterCommandInvocation {
  rawInput: string
}

export interface FreeRouterCommandRegistry {
  register(command: {
    name: string
    description: string
    input: { hint: string }
    handler(invocation: FreeRouterCommandInvocation): Promise<{ kind: 'success' | 'error'; text: string }>
  }): unknown
}

const usage = 'usage: /free-router refresh | status'

function renderReport(report: RefreshReport): string {
  const added = report.addedModelIds.length > 0 ? report.addedModelIds.join(', ') : 'none'
  const removed = report.removedModelIds.length > 0 ? report.removedModelIds.join(', ') : 'none'
  const failures = report.failures.length > 0
    ? report.failures.map(({ provider, code }) => `${provider}:${code}`).join(', ')
    : 'none'
  return [
    `discovered: ${report.discoveredCount}`,
    `eligible: ${report.eligibleCount}`,
    `registration: ${report.registrationKind}`,
    `added: ${added}`,
    `removed: ${removed}`,
    `failures: ${failures}`,
    `startedAt: ${report.startedAt}`,
    `completedAt: ${report.completedAt}`,
  ].join('\n')
}

export function registerFreeRouterCommands(registry: FreeRouterCommandRegistry, view: FreeRouterCommandView): void {
  registry.register({
    name: 'free-router',
    description: 'refresh and inspect free-router model discovery',
    input: { hint: 'refresh | status' },
    handler: async ({ rawInput }) => {
      const input = rawInput.trim()
      if (input === 'status') {
        const report = view.status()
        return report === undefined
          ? { kind: 'success', text: 'no refresh report' }
          : { kind: 'success', text: renderReport(report) }
      }
      if (input !== 'refresh') return { kind: 'error', text: usage }
      try {
        const report = await view.refresh()
        return { kind: 'success', text: renderReport(report) }
      } catch {
        return { kind: 'error', text: 'free-router refresh failed' }
      }
    },
  })
}
