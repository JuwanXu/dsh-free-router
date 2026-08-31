import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import { parseConfig, type RouterConfig } from '../config.js'
import { eligible } from '../eligibility.js'
import { HealthBook } from '../health.js'
import { rankCandidates } from '../ranking.js'
import { candidateKey, type CandidateModel } from '../types.js'
import { AttemptState } from './attempt-state.js'

interface RequestPayload {
  agent: object
  turn: number
  step: number
  signal: AbortSignal
}

interface RequestErrorPayload extends RequestPayload {
  provider: string
  failure: LlmFailure
  retryPolicy?: unknown
}

interface Selection {
  turn: number
  step: number
  candidate: CandidateModel
}

export interface RouterRuntimeDependencies {
  getConfig: () => RouterConfig
  getCandidates: () => readonly CandidateModel[]
  health: HealthBook
  now?: () => number
}

const recoverableFailureCodes = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'UNKNOWN_MODEL',
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'QUOTA',
])

function failureCode(failure: LlmFailure): string {
  return typeof failure.code === 'string' ? failure.code : 'UNKNOWN'
}

/** Request-scoped selection and cross-model recovery policy. */
export class RouterRuntime {
  private readonly attempts = new AttemptState()
  private readonly selections = new WeakMap<object, Selection>()
  private readonly now: () => number

  constructor(private readonly dependencies: RouterRuntimeDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  private rankedCandidates(config = this.dependencies.getConfig()): CandidateModel[] {
    const now = this.now()
    const candidates = this.dependencies.getCandidates().filter((candidate) => {
      const provider = Object.values(config.providers).find((entry) => entry.route === candidate.provider)
      return provider?.enabled === true
        && eligible(candidate, config.routing)
        && !this.dependencies.health.isCooling(candidateKey(candidate), now)
    })
    const health = new Map(candidates.map((candidate) => [
      candidateKey(candidate),
      this.dependencies.health.snapshot(candidateKey(candidate), now),
    ]))
    return rankCandidates(candidates, health, now).slice(0, config.routing.maxAttemptsPerStep)
  }

  async onRequest(payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> {
    const original = await next()
    const config = this.dependencies.getConfig()
    if (!config.enabled) return original

    const candidate = this.attempts.next(payload.agent, payload.turn, payload.step, this.rankedCandidates(config))
    if (candidate === undefined) return original

    this.selections.set(payload.agent, { turn: payload.turn, step: payload.step, candidate })
    const { reasoningEffort: _reasoningEffort, ...call } = original
    return { ...call, provider: candidate.provider, model: candidate.model }
  }

  async onRequestError(
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const selection = this.selections.get(payload.agent)
    const code = failureCode(payload.failure)
    if (selection === undefined
      || selection.turn !== payload.turn
      || selection.step !== payload.step
      || selection.candidate.provider !== payload.provider
      || !recoverableFailureCodes.has(code)) {
      return next()
    }

    this.dependencies.health.record(candidateKey(selection.candidate), { kind: 'failure', code }, this.now())
    const config = this.dependencies.getConfig()
    if (!config.enabled || !this.attempts.hasRemaining(payload.agent, payload.turn, payload.step, this.rankedCandidates(config))) {
      return next()
    }
    return { kind: 'retry' }
  }
}

export function createRouterRuntime(dependencies: RouterRuntimeDependencies): RouterRuntime {
  return new RouterRuntime({ ...dependencies, getConfig: () => parseConfig(dependencies.getConfig()) })
}
