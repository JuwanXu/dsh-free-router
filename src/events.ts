import type { HealthSnapshot } from './types.js'

export interface FreeRouterMetrics extends Omit<HealthSnapshot, 'averageFirstByteMs'> {
  averageFirstByteMs: number | null
}

/** Durable, non-surface telemetry emitted for routing decisions. */
export interface FreeRouterSelectedEvent {
  turn: number
  step: number
  attempt: number
  provider: string
  model: string
  reason: 'policy'
  metrics: FreeRouterMetrics
}

export interface FreeRouterFailoverEvent {
  turn: number
  step: number
  attempt: number
  provider: string
  model: string
  failureCode: string
  isolatedScope: 'model' | 'provider'
  nextProvider: string
  nextModel: string
  attempts: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'free-router/selected': FreeRouterSelectedEvent
    'free-router/failover': FreeRouterFailoverEvent
  }
}
