import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest, type GenerateOptions, type LlmCallConfig, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseConfig, type RouterConfig } from '../config.js'
import { eligible } from '../eligibility.js'
import { HealthBook, type HealthOutcome } from '../health.js'
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
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void }
  probe?: (candidate: CandidateModel, signal: AbortSignal) => Promise<HealthOutcome>
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
  private readonly probeAbort = new AbortController()
  private readonly running = new Set<Promise<void>>()
  private timer: { cancel(): void } | undefined

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

  observeStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next()
    const candidate = this.dependencies.getCandidates().find((item) => (
      item.provider === options.provider && item.model === options.model
    ))
    if (candidate === undefined) return next()
    return this.observeCandidateStream(candidate, next)
  }

  private async *observeCandidateStream(
    candidate: CandidateModel,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const startedAt = this.now()
    let firstChunkAt: number | undefined
    let finished = false
    try {
      for await (const chunk of next()) {
        if (firstChunkAt === undefined) firstChunkAt = this.now()
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            this.dependencies.health.record(candidateKey(candidate), {
              kind: 'failure', code: chunk.reason.failure.code,
            }, this.now())
          } else {
            this.dependencies.health.record(candidateKey(candidate), {
              kind: 'success', firstByteMs: Math.max(0, (firstChunkAt ?? this.now()) - startedAt),
            }, this.now())
          }
        }
        yield chunk
      }
    } catch (error) {
      this.dependencies.health.record(candidateKey(candidate), { kind: 'failure', code: 'TRANSPORT' }, this.now())
      throw error
    } finally {
      if (!finished && this.probeAbort.signal.aborted) return
    }
  }

  start(): void {
    if (this.dependencies.probe === undefined || this.timer !== undefined || this.probeAbort.signal.aborted) return
    this.track(this.runProbes())
    const interval = this.dependencies.getConfig().health.activeProbeIntervalMs
    this.timer = (this.dependencies.schedule ?? defaultSchedule)(() => this.track(this.runProbes()), interval)
  }

  async dispose(): Promise<void> {
    this.probeAbort.abort()
    this.timer?.cancel()
    this.timer = undefined
    await Promise.allSettled([...this.running])
  }

  private track(promise: Promise<void>): void {
    this.running.add(promise)
    void promise.then(
      () => this.running.delete(promise),
      () => this.running.delete(promise),
    )
  }

  private async runProbes(): Promise<void> {
    const probe = this.dependencies.probe
    if (probe === undefined || this.probeAbort.signal.aborted) return
    const maximumPerProvider = this.dependencies.getConfig().health.maxCandidatesPerProvider
    const perProvider = new Map<string, number>()
    const targets = this.rankedCandidates().filter((candidate) => {
      const count = perProvider.get(candidate.provider) ?? 0
      if (count >= maximumPerProvider) return false
      perProvider.set(candidate.provider, count + 1)
      return true
    })
    await Promise.all(targets.map(async (candidate) => {
      try {
        const outcome = await probe(candidate, this.probeAbort.signal)
        if (!this.probeAbort.signal.aborted) this.dependencies.health.record(candidateKey(candidate), outcome, this.now())
      } catch {
        if (!this.probeAbort.signal.aborted) {
          this.dependencies.health.record(candidateKey(candidate), { kind: 'failure', code: 'TRANSPORT' }, this.now())
        }
      }
    }))
  }
}

function defaultSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setInterval(callback, delayMs)
  return { cancel: () => clearInterval(timer) }
}

export function createRouterRuntime(dependencies: RouterRuntimeDependencies): RouterRuntime {
  return new RouterRuntime({ ...dependencies, getConfig: () => parseConfig(dependencies.getConfig()) })
}
