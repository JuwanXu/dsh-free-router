import type { HealthSnapshot } from './types.js'

const providerFailureCodes = new Set([
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'QUOTA',
])

export type HealthOutcome =
  | { kind: 'success'; firstByteMs: number }
  | { kind: 'failure'; code: string }

export interface HealthBookOptions {
  baseCooldownMs: number
  maxCooldownMs: number
  sampleSize: number
}

interface Sample {
  success: boolean
  firstByteMs?: number
}

interface CandidateHealth {
  samples: Sample[]
  consecutiveFailures: number
  coolingUntil: number
}

function providerOf(candidateKey: string): string {
  return candidateKey.slice(0, candidateKey.indexOf('/'))
}

export class HealthBook {
  private readonly candidates = new Map<string, CandidateHealth>()
  private readonly providerCoolingUntil = new Map<string, number>()

  constructor(private readonly options: HealthBookOptions) {}

  record(candidateKey: string, outcome: HealthOutcome, at: number): void {
    const health = this.candidates.get(candidateKey) ?? {
      samples: [],
      consecutiveFailures: 0,
      coolingUntil: 0,
    }
    health.samples.push(outcome.kind === 'success'
      ? { success: true, firstByteMs: outcome.firstByteMs }
      : { success: false })
    if (health.samples.length > this.options.sampleSize) health.samples.shift()

    if (outcome.kind === 'success') {
      health.consecutiveFailures = 0
      health.coolingUntil = 0
    } else {
      health.consecutiveFailures += 1
      const cooldown = Math.min(
        this.options.baseCooldownMs * 2 ** (health.consecutiveFailures - 1),
        this.options.maxCooldownMs,
      )
      const coolingUntil = at + cooldown
      if (providerFailureCodes.has(outcome.code)) {
        this.providerCoolingUntil.set(providerOf(candidateKey), coolingUntil)
      } else {
        health.coolingUntil = coolingUntil
      }
    }

    this.candidates.set(candidateKey, health)
  }

  isCooling(candidateKey: string, now: number): boolean {
    const candidateCoolingUntil = this.candidates.get(candidateKey)?.coolingUntil ?? 0
    const providerCoolingUntil = this.providerCoolingUntil.get(providerOf(candidateKey)) ?? 0
    return Math.max(candidateCoolingUntil, providerCoolingUntil) > now
  }

  snapshot(candidateKey: string, now: number): HealthSnapshot {
    const health = this.candidates.get(candidateKey)
    if (!health) {
      return {
        status: 'unknown',
        averageFirstByteMs: Number.POSITIVE_INFINITY,
        successRate: 0,
        consecutiveFailures: 0,
        coolingUntil: 0,
      }
    }

    const coolingUntil = Math.max(
      health.coolingUntil,
      this.providerCoolingUntil.get(providerOf(candidateKey)) ?? 0,
    )
    const successful = health.samples.filter((sample) => sample.success)
    const firstByteSamples = successful
      .map((sample) => sample.firstByteMs)
      .filter((value): value is number => value !== undefined)
    const averageFirstByteMs = firstByteSamples.length === 0
      ? Number.POSITIVE_INFINITY
      : firstByteSamples.reduce((total, value) => total + value, 0) / firstByteSamples.length
    const status = coolingUntil > now
      ? 'unavailable'
      : health.samples.at(-1)?.success
        ? 'available'
        : health.samples.length === 0
          ? 'unknown'
          : 'unavailable'

    return {
      status,
      averageFirstByteMs,
      successRate: successful.length / health.samples.length,
      consecutiveFailures: health.consecutiveFailures,
      coolingUntil,
    }
  }

  restore(snapshots: Readonly<Record<string, HealthSnapshot>>): void {
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!Number.isFinite(snapshot.averageFirstByteMs)
        || !Number.isFinite(snapshot.successRate)
        || !Number.isInteger(snapshot.consecutiveFailures)
        || !Number.isFinite(snapshot.coolingUntil)) continue
      const success = snapshot.status === 'available'
      this.candidates.set(key, {
        samples: [{ success, ...(success ? { firstByteMs: snapshot.averageFirstByteMs } : {}) }],
        consecutiveFailures: Math.max(0, snapshot.consecutiveFailures),
        coolingUntil: Math.max(0, snapshot.coolingUntil),
      })
    }
  }

  snapshots(candidateKeys: readonly string[], now: number): Record<string, HealthSnapshot> {
    return Object.fromEntries(candidateKeys.map((key) => [key, this.snapshot(key, now)]))
  }
}
