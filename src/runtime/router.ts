import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest, type GenerateOptions, type LlmCallConfig, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseConfig, type RouterConfig } from '../config.js'
import { eligible } from '../eligibility.js'
import { HealthBook, isProviderFailure, type HealthOutcome } from '../health.js'
import { rankCandidates } from '../ranking.js'
import { candidateKey, type CandidateModel, type HealthSnapshot } from '../types.js'
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

interface ActiveStream {
  close(): Promise<void>
}

export interface RouterSelectionEvent {
  agent: object
  turn: number
  step: number
  attempt: number
  candidate: CandidateModel
  reason: 'policy'
  metrics: HealthSnapshot
}

export interface RouterFailoverEvent {
  agent: object
  turn: number
  step: number
  attempt: number
  failedCandidate: CandidateModel
  failureCode: string
  isolatedScope: 'model' | 'provider'
  nextCandidate: CandidateModel
  attempts: number
}

export interface RouterExhaustedEvent {
  turn: number
  step: number
  attempts: number
  failureCode: string
  attemptedCandidates: string[]
}

export interface RouterRuntimeDependencies {
  getConfig: () => RouterConfig
  getCandidates: () => readonly CandidateModel[]
  health: HealthBook
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void }
  probe?: (candidate: CandidateModel, signal: AbortSignal) => Promise<HealthOutcome>
  onUnknownModel?: (candidate: CandidateModel) => void
  onHealthChange?: () => void
  onSelected?: (event: RouterSelectionEvent) => void
  onFailover?: (event: RouterFailoverEvent) => void
  onExhausted?: (event: RouterExhaustedEvent) => void
  disposeTimeoutMs?: number
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
  private readonly disposeTimeoutMs: number
  private readonly probeAbort = new AbortController()
  private readonly running = new Set<Promise<void>>()
  private readonly activeStreams = new Set<ActiveStream>()
  private readonly observedFailures = new Map<string, string[]>()
  private timer: { cancel(): void } | undefined
  private probeRoundRunning = false
  private probeWakePending = false

  constructor(private readonly dependencies: RouterRuntimeDependencies) {
    this.now = dependencies.now ?? Date.now
    this.disposeTimeoutMs = dependencies.disposeTimeoutMs ?? dependencies.getConfig().health.timeoutMs
  }

  private rankedCandidates(
    config = this.dependencies.getConfig(),
    limit = Number.POSITIVE_INFINITY,
  ): CandidateModel[] {
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
    return rankCandidates(candidates, health, now).slice(0, limit)
  }

  async onRequest(payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> {
    const original = await next()
    if (this.probeAbort.signal.aborted) return original
    const config = this.dependencies.getConfig()
    if (!config.enabled) return original

    const candidate = this.attempts.next(
      payload.agent,
      payload.turn,
      payload.step,
      this.rankedCandidates(config, Number.POSITIVE_INFINITY),
      config.routing.maxAttemptsPerStep,
    )
    if (candidate === undefined) return original

    this.selections.set(payload.agent, { turn: payload.turn, step: payload.step, candidate })
    this.dependencies.onSelected?.({
      agent: payload.agent,
      turn: payload.turn,
      step: payload.step,
      attempt: this.attempts.count(payload.agent, payload.turn, payload.step),
      candidate,
      reason: 'policy',
      metrics: this.dependencies.health.snapshot(candidateKey(candidate), this.now()),
    })
    const { reasoningEffort: _reasoningEffort, ...call } = original
    return { ...call, provider: candidate.provider, model: candidate.model }
  }

  async onRequestError(
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (this.probeAbort.signal.aborted) return next()
    const selection = this.selections.get(payload.agent)
    const code = failureCode(payload.failure)
    if (selection === undefined
      || selection.turn !== payload.turn
      || selection.step !== payload.step
      || selection.candidate.provider !== payload.provider) {
      return next()
    }
    if (!recoverableFailureCodes.has(code)) {
      this.attempts.stop(payload.agent, payload.turn, payload.step)
      return next()
    }

    if (!this.consumeObservedFailure(selection.candidate, code)) {
      this.recordHealth(selection.candidate, { kind: 'failure', code })
    }
    if (code === 'UNKNOWN_MODEL') this.dependencies.onUnknownModel?.(selection.candidate)
    const config = this.dependencies.getConfig()
    const ranked = this.rankedCandidates(config, Number.POSITIVE_INFINITY)
    if (!config.enabled || !this.attempts.hasRemaining(
      payload.agent,
      payload.turn,
      payload.step,
      ranked,
      config.routing.maxAttemptsPerStep,
    )) {
      this.dependencies.onExhausted?.({
        turn: payload.turn,
        step: payload.step,
        attempts: this.attempts.count(payload.agent, payload.turn, payload.step),
        failureCode: code,
        attemptedCandidates: this.attempts.tried(payload.agent, payload.turn, payload.step),
      })
      return next()
    }
    const nextCandidate = this.attempts.peek(
      payload.agent,
      payload.turn,
      payload.step,
      ranked,
      config.routing.maxAttemptsPerStep,
    )
    if (nextCandidate !== undefined) {
      this.dependencies.onFailover?.({
        agent: payload.agent,
        turn: payload.turn,
        step: payload.step,
        attempt: this.attempts.count(payload.agent, payload.turn, payload.step),
        failedCandidate: selection.candidate,
        failureCode: code,
        isolatedScope: isProviderFailure(code) ? 'provider' : 'model',
        nextCandidate,
        attempts: this.attempts.count(payload.agent, payload.turn, payload.step),
      })
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
    let completed = false
    const iterator = next()[Symbol.asyncIterator]()
    const activeStream = createActiveStream(iterator)
    this.activeStreams.add(activeStream)
    try {
      while (true) {
        const result = await nextUntilAbort(iterator.next(), this.probeAbort.signal)
        if (result.done) {
          completed = true
          return
        }
        const chunk = result.value
        if (firstChunkAt === undefined) firstChunkAt = this.now()
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            const code = chunk.reason.failure.code
            this.recordHealth(candidate, {
              kind: 'failure', code,
            })
            this.rememberObservedFailure(candidate, code)
          } else {
            this.recordHealth(candidate, {
              kind: 'success', firstByteMs: Math.max(0, (firstChunkAt ?? this.now()) - startedAt),
            })
          }
        }
        yield chunk
      }
    } catch (error) {
      if (this.probeAbort.signal.aborted) return
      this.recordHealth(candidate, { kind: 'failure', code: 'TRANSPORT' })
      this.rememberObservedFailure(candidate, 'TRANSPORT')
      throw error
    } finally {
      this.activeStreams.delete(activeStream)
      if (!completed) void activeStream.close()
    }
  }

  start(): void {
    if (this.dependencies.probe === undefined || this.timer !== undefined || this.probeAbort.signal.aborted) return
    this.wake()
  }

  /** Cancel an idle timer and immediately probe using the latest catalog. */
  wake(): void {
    if (this.dependencies.probe === undefined || this.probeAbort.signal.aborted) return
    this.timer?.cancel()
    this.timer = undefined
    if (this.probeRoundRunning) this.probeWakePending = true
    else this.track(this.runProbes())
    this.scheduleNextProbe()
  }

  async dispose(): Promise<void> {
    this.probeAbort.abort()
    this.timer?.cancel()
    this.timer = undefined
    await settleWithin([
      ...[...this.activeStreams].map((stream) => stream.close()),
      ...this.running,
    ], this.disposeTimeoutMs)
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
    if (probe === undefined || this.probeAbort.signal.aborted || this.probeRoundRunning) return
    this.probeRoundRunning = true
    try {
      const maximumPerProvider = this.dependencies.getConfig().health.maxCandidatesPerProvider
      const perProvider = new Map<string, number>()
      const targets = this.rankedCandidates(undefined, Number.POSITIVE_INFINITY).filter((candidate) => {
        const count = perProvider.get(candidate.provider) ?? 0
        if (count >= maximumPerProvider) return false
        perProvider.set(candidate.provider, count + 1)
        return true
      })
      let next = 0
      const worker = async (): Promise<void> => {
        while (!this.probeAbort.signal.aborted) {
          const candidate = targets[next]
          next += 1
          if (candidate === undefined) return
          await this.probeCandidate(candidate, probe)
        }
      }
      const concurrency = Math.min(this.dependencies.getConfig().health.concurrency, targets.length)
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
    } finally {
      this.probeRoundRunning = false
      if (this.probeWakePending && !this.probeAbort.signal.aborted) {
        this.probeWakePending = false
        this.track(this.runProbes())
      }
    }
  }

  private scheduleNextProbe(): void {
    if (this.probeAbort.signal.aborted) return
    const config = this.dependencies.getConfig()
    const hasCandidates = this.hasEligibleCandidates(config)
    const delayMs = hasCandidates ? config.health.activeProbeIntervalMs : config.health.idleProbeIntervalMs
    this.timer = (this.dependencies.schedule ?? defaultSchedule)(() => {
      this.timer = undefined
      const round = this.runProbes()
      this.track(round)
      void round.then(() => this.scheduleNextProbe(), () => this.scheduleNextProbe())
    }, delayMs)
  }

  private hasEligibleCandidates(config: RouterConfig): boolean {
    return this.dependencies.getCandidates().some((candidate) => {
      const provider = Object.values(config.providers).find((entry) => entry.route === candidate.provider)
      return provider?.enabled === true && eligible(candidate, config.routing)
    })
  }

  private async probeCandidate(
    candidate: CandidateModel,
    probe: NonNullable<RouterRuntimeDependencies['probe']>,
  ): Promise<void> {
    try {
      const outcome = await probe(candidate, this.probeAbort.signal)
      if (!this.probeAbort.signal.aborted) this.recordHealth(candidate, outcome)
    } catch {
      if (!this.probeAbort.signal.aborted) {
        this.recordHealth(candidate, { kind: 'failure', code: 'TRANSPORT' })
      }
    }
  }

  private rememberObservedFailure(candidate: CandidateModel, code: string): void {
    const key = candidateKey(candidate)
    this.observedFailures.set(key, [...(this.observedFailures.get(key) ?? []), code])
  }

  private consumeObservedFailure(candidate: CandidateModel, code: string): boolean {
    const key = candidateKey(candidate)
    const failures = this.observedFailures.get(key)
    if (failures === undefined) return false
    const index = failures.indexOf(code)
    if (index === -1) return false
    failures.splice(index, 1)
    if (failures.length === 0) this.observedFailures.delete(key)
    return true
  }

  private recordHealth(candidate: CandidateModel, outcome: HealthOutcome): void {
    if (this.probeAbort.signal.aborted) return
    this.dependencies.health.record(candidateKey(candidate), outcome, this.now())
    this.dependencies.onHealthChange?.()
  }
}

function createActiveStream(iterator: AsyncIterator<StreamChunk>): ActiveStream {
  let closing: Promise<void> | undefined
  return {
    close: () => {
      if (closing !== undefined) return closing
      try {
        closing = Promise.resolve(iterator.return?.()).then(() => undefined, () => undefined)
      } catch {
        closing = Promise.resolve()
      }
      return closing
    },
  }
}

function nextUntilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(
      signal.reason ?? new DOMException('运行时已释放', 'AbortError'),
    ))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

async function settleWithin(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

function defaultSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  return { cancel: () => clearTimeout(timer) }
}

export function createRouterRuntime(dependencies: RouterRuntimeDependencies): RouterRuntime {
  return new RouterRuntime({ ...dependencies, getConfig: () => parseConfig(dependencies.getConfig()) })
}
