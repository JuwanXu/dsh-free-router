const safeErrorCodes = new Set([
  'ABORT_ERR', 'AUTH', 'EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT', 'INVARIANT',
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'TIMEOUT', 'UNKNOWN',
])
const safeRegistrationReasons = new Set(['missing-source-profile', 'target-exists', 'ownership-mismatch'])

export type RegistrationRefreshKind = 'none' | 'create' | 'update' | 'delete' | 'unchanged' | 'conflict' | 'skipped' | 'error'

export interface RefreshFailure {
  provider: string
  code: string
}

export interface RefreshReport {
  startedAt: number
  completedAt: number
  discoveredCount: number
  eligibleCount: number
  candidateCount: number
  registrationKind: RegistrationRefreshKind
  registration: { kind: RegistrationRefreshKind; reason?: string }
  addedModelIds: readonly string[]
  removedModelIds: readonly string[]
  failures: readonly RefreshFailure[]
}

export interface CreateRefreshReportInput {
  startedAt: number
  completedAt: number
  discoveredModelIds: readonly string[]
  eligibleModelIds: readonly string[]
  candidateCount?: number
  previousModelIds: readonly string[]
  registrationKind: RegistrationRefreshKind
  registrationReason?: string
  failures: readonly { provider: string; code?: unknown }[]
}

function safeFailureCode(code: unknown): string {
  return typeof code === 'string' && safeErrorCodes.has(code) ? code : 'UNKNOWN'
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function createRefreshReport(input: CreateRefreshReportInput): RefreshReport {
  const discovered = sortedUnique(input.discoveredModelIds)
  const eligible = sortedUnique(input.eligibleModelIds)
  const previous = new Set(input.previousModelIds)
  const current = new Set(discovered)
  return {
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    discoveredCount: discovered.length,
    eligibleCount: eligible.length,
    candidateCount: input.candidateCount ?? 0,
    registrationKind: input.registrationKind,
    registration: { kind: input.registrationKind, ...(input.registrationReason !== undefined && safeRegistrationReasons.has(input.registrationReason) ? { reason: input.registrationReason } : {}) },
    addedModelIds: discovered.filter((modelId) => !previous.has(modelId)),
    removedModelIds: sortedUnique(input.previousModelIds).filter((modelId) => !current.has(modelId)),
    failures: input.failures.map(({ provider, code }) => ({ provider, code: safeFailureCode(code) }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.code.localeCompare(right.code)),
  }
}
