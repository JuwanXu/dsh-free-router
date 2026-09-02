import type {
  HealthRecoverySnapshot,
  HealthSnapshot,
  HealthStatus,
  ModelHealthRecoverySnapshot,
} from './types.js'

const providerFailureCodes = new Set([
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'QUOTA',
])

/** 判断故障是否会使同一 Provider 的所有路由失效。 */
export function isProviderFailure(code: string): boolean {
  return providerFailureCodes.has(code)
}

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
  failureCode?: string
}

interface CandidateHealth {
  samples: Sample[]
  consecutiveFailures: number
  coolingUntil: number
  restored?: {
    status: string
    averageFirstByteMs: number
    successRate: number
    lastFailureCode?: string
    scopedRecovery: boolean
    model: ModelHealthRecoverySnapshot
  }
}

function providerOf(candidateKey: string): string {
  return candidateKey.slice(0, candidateKey.indexOf('/'))
}

export class HealthBook {
  private readonly candidates = new Map<string, CandidateHealth>()
  private readonly providerCoolingUntil = new Map<string, number>()
  private readonly providerFailureCode = new Map<string, string>()

  constructor(private readonly options: HealthBookOptions) {}

  record(candidateKey: string, outcome: HealthOutcome, at: number): void {
    const health = this.candidates.get(candidateKey) ?? {
      samples: [],
      consecutiveFailures: 0,
      coolingUntil: 0,
    }
    health.samples.push(outcome.kind === 'success'
      ? { success: true, firstByteMs: outcome.firstByteMs }
      : { success: false, failureCode: outcome.code })
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
      if (isProviderFailure(outcome.code)) {
        const provider = providerOf(candidateKey)
        this.providerCoolingUntil.set(provider, coolingUntil)
        this.providerFailureCode.set(provider, outcome.code)
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
      const provider = providerOf(candidateKey)
      const coolingUntil = this.providerCoolingUntil.get(provider) ?? 0
      const providerFailureCode = this.providerFailureCode.get(provider)
      return {
        status: coolingUntil > now ? 'unavailable' : 'unknown',
        averageFirstByteMs: Number.POSITIVE_INFINITY,
        successRate: 0,
        consecutiveFailures: 0,
        coolingUntil,
        lastFailureCode: providerFailureCode,
        recovery: recoverySnapshot({
          status: 'unknown',
          successRate: 0,
          consecutiveFailures: 0,
          coolingUntil: 0,
        }, coolingUntil, providerFailureCode),
      }
    }

    if (health.samples.length === 0 && health.restored !== undefined) {
      const provider = providerOf(candidateKey)
      const providerCoolingUntil = this.providerCoolingUntil.get(provider) ?? 0
      const providerFailureCode = this.providerFailureCode.get(provider)
      const coolingUntil = Math.max(health.coolingUntil, providerCoolingUntil)
      return {
        status: coolingUntil > now
          ? 'unavailable'
          : health.restored.status,
        averageFirstByteMs: health.restored.averageFirstByteMs,
        successRate: health.restored.successRate,
        consecutiveFailures: health.consecutiveFailures,
        coolingUntil,
        lastFailureCode: health.restored.lastFailureCode
          ?? providerFailureCode,
        recovery: recoverySnapshot({
          ...health.restored.model,
          coolingUntil: health.coolingUntil,
        }, providerCoolingUntil, providerFailureCode),
      }
    }

    const provider = providerOf(candidateKey)
    const providerCoolingUntil = this.providerCoolingUntil.get(provider) ?? 0
    const providerFailureCode = this.providerFailureCode.get(provider)
    const coolingUntil = Math.max(health.coolingUntil, providerCoolingUntil)
    const model = summarizeModelHealth(health.samples, health.coolingUntil, now)
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
      successRate: health.samples.length === 0 ? 0 : successful.length / health.samples.length,
      consecutiveFailures: health.consecutiveFailures,
      coolingUntil,
      lastFailureCode: health.samples.at(-1)?.failureCode
        ?? providerFailureCode,
      recovery: recoverySnapshot({
        ...model,
        coolingUntil: health.coolingUntil,
      }, providerCoolingUntil, providerFailureCode),
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
      const lastFailureCode = typeof snapshot.lastFailureCode === 'string'
        ? snapshot.lastFailureCode
        : undefined
      const aggregateCoolingUntil = Math.max(0, snapshot.coolingUntil)
      const recovery = validRecoverySnapshot(snapshot.recovery) ? snapshot.recovery : undefined
      const scopedModelCoolingUntil = recovery?.model.coolingUntil
      const scopedProviderCoolingUntil = recovery?.provider.coolingUntil
      const scopedRecovery = recovery !== undefined
      const modelCoolingUntil = stale
        ? 0
        : scopedModelCoolingUntil
          ?? (lastFailureCode !== undefined && isProviderFailure(lastFailureCode) ? 0 : aggregateCoolingUntil)
      const providerCoolingUntil = stale
        ? 0
        : scopedProviderCoolingUntil
          ?? (lastFailureCode !== undefined && isProviderFailure(lastFailureCode) ? aggregateCoolingUntil : 0)
      const providerFailureCode = recovery?.provider.failureCode !== undefined
        ? recovery.provider.failureCode
        : lastFailureCode !== undefined && isProviderFailure(lastFailureCode)
          ? lastFailureCode
          : undefined
      const modelStatus = stale
        ? 'unknown'
        : recovery !== undefined
          ? recovery.model.status
          : lastFailureCode !== undefined && !isProviderFailure(lastFailureCode)
            ? 'unavailable'
            : 'unknown'
      const modelSuccessRate = recovery !== undefined
        ? recovery.model.successRate
        : snapshot.successRate
      const modelConsecutiveFailures = stale
        ? 0
        : recovery !== undefined
          ? recovery.model.consecutiveFailures
          : lastFailureCode !== undefined && !isProviderFailure(lastFailureCode)
            ? snapshot.consecutiveFailures
            : 0
      const modelLastFailureCode = stale
        ? undefined
        : recovery?.model.lastFailureCode !== undefined
          ? recovery.model.lastFailureCode
          : lastFailureCode !== undefined && !isProviderFailure(lastFailureCode)
            ? lastFailureCode
            : undefined
      if (providerCoolingUntil > 0) {
        const provider = providerOf(key)
        this.providerCoolingUntil.set(provider, Math.max(
          this.providerCoolingUntil.get(provider) ?? 0,
          providerCoolingUntil,
        ))
        if (providerFailureCode !== undefined) this.providerFailureCode.set(provider, providerFailureCode)
      }
      this.candidates.set(key, {
        samples: [],
        consecutiveFailures: stale
          ? 0
          : recovery?.model.consecutiveFailures ?? snapshot.consecutiveFailures,
        coolingUntil: modelCoolingUntil,
        restored: {
          status: stale
            ? 'unknown'
            : scopedRecovery
              ? modelStatus
              : snapshot.status === 'unavailable' && snapshot.consecutiveFailures === 0
                ? 'unknown'
                : snapshot.status,
          averageFirstByteMs,
          successRate: snapshot.successRate,
          lastFailureCode,
          scopedRecovery,
          model: {
            status: modelStatus,
            successRate: modelSuccessRate,
            consecutiveFailures: modelConsecutiveFailures,
            coolingUntil: modelCoolingUntil,
            ...(modelLastFailureCode === undefined ? {} : { lastFailureCode: modelLastFailureCode }),
          },
        },
      })
    }
  }

  /** 受影响的适配器变化后，仅解除凭据或配额导致的隔离。 */
  clearProvider(provider: string): void {
    this.providerCoolingUntil.delete(provider)
    this.providerFailureCode.delete(provider)
    for (const [key, health] of this.candidates) {
      if (providerOf(key) !== provider) continue
      if (health.restored !== undefined) {
        if (health.restored.scopedRecovery) {
          health.consecutiveFailures = health.restored.model.consecutiveFailures
          health.restored.status = health.restored.model.status
          health.restored.successRate = health.restored.model.successRate
          if (health.restored.model.lastFailureCode === undefined) delete health.restored.lastFailureCode
          else health.restored.lastFailureCode = health.restored.model.lastFailureCode
          continue
        }
        const lastFailureCode = health.restored.lastFailureCode
        const legacyIsolation = lastFailureCode === undefined
          && health.restored.status !== 'available'
          && (health.consecutiveFailures > 0 || health.coolingUntil > 0)
        if (legacyIsolation || (lastFailureCode !== undefined && isProviderFailure(lastFailureCode))) {
          health.consecutiveFailures = 0
          health.coolingUntil = 0
          health.restored.status = 'unknown'
          delete health.restored.lastFailureCode
        }
        continue
      }
      health.samples = health.samples.filter((sample) => !isProviderFailure(sample.failureCode ?? ''))
      health.consecutiveFailures = countTrailingFailures(health.samples)
    }
  }

  snapshots(candidateKeys: readonly string[], now: number): Record<string, HealthSnapshot> {
    return Object.fromEntries(candidateKeys.map((key) => [key, this.snapshot(key, now)]))
  }
}

function countTrailingFailures(samples: readonly Sample[]): number {
  let count = 0
  for (let index = samples.length - 1; index >= 0 && !samples[index].success; index -= 1) count += 1
  return count
}

function validStatus(value: unknown): value is HealthStatus {
  return value === 'available' || value === 'unavailable' || value === 'unknown'
}

function validSuccessRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function validFailureCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function validRecoverySnapshot(value: unknown): value is HealthRecoverySnapshot {
  if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.provider)) return false
  const model = value.model
  const provider = value.provider
  return validStatus(model.status)
    && validSuccessRate(model.successRate)
    && validFailureCount(model.consecutiveFailures)
    && validCoolingUntil(model.coolingUntil) !== undefined
    && (model.lastFailureCode === undefined
      || (typeof model.lastFailureCode === 'string' && model.lastFailureCode.length > 0))
    && validCoolingUntil(provider.coolingUntil) !== undefined
    && (provider.failureCode === undefined
      || (typeof provider.failureCode === 'string' && provider.failureCode.length > 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validCoolingUntil(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function recoverySnapshot(
  model: ModelHealthRecoverySnapshot,
  providerCoolingUntil: number,
  providerFailureCode?: string,
): HealthRecoverySnapshot {
  return {
    model,
    provider: {
      coolingUntil: providerCoolingUntil,
      ...(providerFailureCode === undefined ? {} : { failureCode: providerFailureCode }),
    },
  }
}

function summarizeModelHealth(
  samples: readonly Sample[],
  coolingUntil: number,
  now: number,
): Omit<ModelHealthRecoverySnapshot, 'coolingUntil'> {
  const modelSamples = samples.filter((sample) => !isProviderFailure(sample.failureCode ?? ''))
  const successful = modelSamples.filter((sample) => sample.success)
  const last = modelSamples.at(-1)
  const status = coolingUntil > now
    ? 'unavailable'
    : last?.success
      ? 'available'
      : modelSamples.length === 0
        ? 'unknown'
        : 'unavailable'
  return {
    status,
    successRate: modelSamples.length === 0 ? 0 : successful.length / modelSamples.length,
    consecutiveFailures: countTrailingFailures(modelSamples),
    lastFailureCode: last?.failureCode,
  }
}
