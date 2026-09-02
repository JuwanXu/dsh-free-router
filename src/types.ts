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

export type HealthStatus = 'available' | 'unavailable' | 'unknown'

export interface ModelHealthRecoverySnapshot {
  status: HealthStatus
  successRate: number
  consecutiveFailures: number
  coolingUntil: number
  lastFailureCode?: string
}

export interface ProviderHealthRecoverySnapshot {
  coolingUntil: number
  failureCode?: string
}

/** Scope-specific recovery state kept out of public routing telemetry. */
export interface HealthRecoverySnapshot {
  model: ModelHealthRecoverySnapshot
  provider: ProviderHealthRecoverySnapshot
}

export interface HealthSnapshot {
  status: string
  averageFirstByteMs: number
  successRate: number
  consecutiveFailures: number
  coolingUntil: number
  lastFailureCode?: string
  recovery?: HealthRecoverySnapshot
}

export function candidateKey(candidate: Pick<CandidateModel, 'provider' | 'model'>): string {
  return `${candidate.provider}/${candidate.model}`
}
