import type { CandidateModel, EligibilityPolicy, ModelTier } from './types.js'

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

function tierRank(tier: string): number {
  return tierOrder[tier as ModelTier] ?? tierOrder['?']
}

export function eligible(candidate: CandidateModel, policy: EligibilityPolicy): boolean {
  if (!candidate.free || !candidate.toolCalling) return false
  if (candidate.contextWindow < policy.minimumContextWindow) return false
  if (tierRank(candidate.tier) > tierRank(policy.minimumTier)) return false
  if (policy.excludeModels.includes(candidate.model)) return false
  return policy.includeModels.length === 0 || policy.includeModels.includes(candidate.model)
}
