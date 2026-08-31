import { candidateKey, type CandidateModel } from '../types.js'

interface StepAttempts {
  turn: number
  step: number
  tried: Set<string>
}

export class AttemptState {
  private readonly attempts = new WeakMap<object, StepAttempts>()

  next(
    agent: object,
    turn: number,
    step: number,
    candidates: readonly CandidateModel[],
  ): CandidateModel | undefined {
    let current = this.attempts.get(agent)
    if (current === undefined || current.turn !== turn || current.step !== step) {
      current = { turn, step, tried: new Set() }
      this.attempts.set(agent, current)
    }

    const selected = candidates.find((candidate) => !current.tried.has(candidateKey(candidate)))
    if (selected !== undefined) current.tried.add(candidateKey(selected))
    return selected
  }
}
