import { candidateKey, type CandidateModel } from '../types.js'

interface StepAttempts {
  turn: number
  step: number
  tried: Set<string>
  count: number
  maxAttempts: number
  stopped: boolean
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Number.POSITIVE_INFINITY
}

export class AttemptState {
  private readonly attempts = new WeakMap<object, StepAttempts>()

  next(
    agent: object,
    turn: number,
    step: number,
    candidates: readonly CandidateModel[],
    maxAttempts = Number.POSITIVE_INFINITY,
  ): CandidateModel | undefined {
    let current = this.attempts.get(agent)
    if (current === undefined || current.turn !== turn || current.step !== step) {
      current = { turn, step, tried: new Set(), count: 0, maxAttempts: normalizeLimit(maxAttempts), stopped: false }
      this.attempts.set(agent, current)
    } else {
      current.maxAttempts = Math.min(current.maxAttempts, normalizeLimit(maxAttempts))
    }

    if (current.stopped || current.count >= current.maxAttempts) return undefined
    const selected = candidates.find((candidate) => !current.tried.has(candidateKey(candidate)))
    if (selected !== undefined) {
      current.tried.add(candidateKey(selected))
      current.count += 1
    }
    return selected
  }

  hasRemaining(
    agent: object,
    turn: number,
    step: number,
    candidates: readonly CandidateModel[],
    maxAttempts = Number.POSITIVE_INFINITY,
  ): boolean {
    const current = this.attempts.get(agent)
    if (current === undefined || current.turn !== turn || current.step !== step) {
      return candidates.length > 0 && normalizeLimit(maxAttempts) > 0
    }
    current.maxAttempts = Math.min(current.maxAttempts, normalizeLimit(maxAttempts))
    if (current.stopped || current.count >= current.maxAttempts) return false
    return candidates.some((candidate) => !current.tried.has(candidateKey(candidate)))
  }

  peek(
    agent: object,
    turn: number,
    step: number,
    candidates: readonly CandidateModel[],
    maxAttempts = Number.POSITIVE_INFINITY,
  ): CandidateModel | undefined {
    const current = this.attempts.get(agent)
    if (current === undefined || current.turn !== turn || current.step !== step) return undefined
    current.maxAttempts = Math.min(current.maxAttempts, normalizeLimit(maxAttempts))
    if (current.stopped || current.count >= current.maxAttempts) return undefined
    return candidates.find((candidate) => !current.tried.has(candidateKey(candidate)))
  }

  stop(agent: object, turn: number, step: number): void {
    const current = this.attempts.get(agent)
    if (current !== undefined && current.turn === turn && current.step === step) current.stopped = true
  }

  count(agent: object, turn: number, step: number): number {
    const current = this.attempts.get(agent)
    if (current === undefined || current.turn !== turn || current.step !== step) return 0
    return current.count
  }
}
