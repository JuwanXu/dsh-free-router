import { candidateKey, type CandidateModel, type HealthSnapshot, type ModelTier } from './types.js'

const tierOrder: Record<ModelTier, number> = {
  'S+': 0,
  S: 1,
  'A+': 2,
  A: 3,
  'A-': 4,
  'B+': 5,
  B: 6,
  C: 7,
  '?': 8,
}

const unknownHealth: HealthSnapshot = {
  status: 'unknown',
  averageFirstByteMs: Number.POSITIVE_INFINITY,
  successRate: 0,
  consecutiveFailures: 0,
  coolingUntil: 0,
}

function availabilityRank(health: HealthSnapshot, now: number): number {
  if (health.coolingUntil > now || health.status === 'unavailable') return 2
  return health.status === 'available' ? 0 : 1
}

function tierRank(tier: string): number {
  return tierOrder[tier as ModelTier] ?? tierOrder['?']
}

function latencyRank(value: number): number {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

export function rankCandidates(
  candidates: readonly CandidateModel[],
  healthByCandidate: ReadonlyMap<string, HealthSnapshot>,
  now: number,
): CandidateModel[] {
  return [...candidates].sort((left, right) => {
    const leftHealth = healthByCandidate.get(candidateKey(left)) ?? unknownHealth
    const rightHealth = healthByCandidate.get(candidateKey(right)) ?? unknownHealth

    const availability = availabilityRank(leftHealth, now) - availabilityRank(rightHealth, now)
    if (availability !== 0) return availability

    const tier = tierRank(left.tier) - tierRank(right.tier)
    if (tier !== 0) return tier

    const leftLatency = latencyRank(leftHealth.averageFirstByteMs)
    const rightLatency = latencyRank(rightHealth.averageFirstByteMs)
    if (leftLatency !== rightLatency) return leftLatency < rightLatency ? -1 : 1

    const successRate = rightHealth.successRate - leftHealth.successRate
    if (successRate !== 0) return successRate

    return candidateKey(left).localeCompare(candidateKey(right))
  })
}
