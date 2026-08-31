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
  restored?: {
    status: string
    averageFirstByteMs: number
    successRate: number
  }
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

    delete health.restored
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
      const coolingUntil = this.providerCoolingUntil.get(providerOf(candidateKey)) ?? 0
      return {
        status: coolingUntil > now ? 'unavailable' : 'unknown',
        averageFirstByteMs: Number.POSITIVE_INFINITY,
        successRate: 0,
        consecutiveFailures: 0,
        coolingUntil,
      }
    }

    if (health.samples.length === 0 && health.restored !== undefined) {
      const coolingUntil = Math.max(
        health.coolingUntil,
        this.providerCoolingUntil.get(providerOf(candidateKey)) ?? 0,
      )
      return {
        status: coolingUntil > now
          ? 'unavailable'
          : health.restored.status,
        averageFirstByteMs: health.restored.averageFirstByteMs,
        successRate: health.restored.successRate,
        consecutiveFailures: health.consecutiveFailures,
        coolingUntil,
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

  restore(
    snapshots: Readonly<Record<string, HealthSnapshot>>,
    options: { stale?: boolean } = {},
  ): void {
    const stale = options.stale === true
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if ((typeof snapshot.averageFirstByteMs !== 'number'
        && snapshot.averageFirstByteMs !== null)
        || !Number.isFinite(snapshot.successRate)
        || snapshot.successRate < 0 || snapshot.successRate > 1
        || !Number.isInteger(snapshot.consecutiveFailures)
        || snapshot.consecutiveFailures < 0
        || !Number.isFinite(snapshot.coolingUntil)) continue
      const averageFirstByteMs = snapshot.averageFirstByteMs === null
        || !Number.isFinite(snapshot.averageFirstByteMs)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, snapshot.averageFirstByteMs)
      this.candidates.set(key, {
        samples: [],
        consecutiveFailures: snapshot.consecutiveFailures,
        coolingUntil: stale ? 0 : Math.max(0, snapshot.coolingUntil),
        restored: {
          status: stale || (snapshot.status === 'unavailable' && snapshot.consecutiveFailures === 0)
            ? 'unknown'
            : snapshot.status,
          averageFirstByteMs,
          successRate: snapshot.successRate,
        },
      })
    }
  }

  /** Clear provider-wide credential/quota isolation after adapter configuration changes. */
  clearProvider(provider: string): void {
    this.providerCoolingUntil.delete(provider)
    for (const [key, health] of this.candidates) {
      if (providerOf(key) !== provider) continue
      health.samples = []
      health.consecutiveFailures = 0
      health.coolingUntil = 0
      delete health.restored
    }
  }

  snapshots(candidateKeys: readonly string[], now: number): Record<string, HealthSnapshot> {
    return Object.fromEntries(candidateKeys.map((key) => [key, this.snapshot(key, now)]))
  }
}
