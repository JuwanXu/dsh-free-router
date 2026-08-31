export type ModelTier = 'S+' | 'S' | 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'C' | '?'

export interface CandidateModel {
  provider: string
  model: string
  displayName: string
  contextWindow: number
  toolCalling: boolean
  free: boolean
  tier: ModelTier | string
  catalogUpdatedAt: number
}

export interface EligibilityPolicy {
  minimumContextWindow: number
  minimumTier: ModelTier | string
  includeModels: readonly string[]
  excludeModels: readonly string[]
}

export interface HealthSnapshot {
  status: string
  averageFirstByteMs: number
  successRate: number
  consecutiveFailures: number
  coolingUntil: number
}

export function candidateKey(candidate: Pick<CandidateModel, 'provider' | 'model'>): string {
  return `${candidate.provider}/${candidate.model}`
}
