const safeErrorCodes = new Set([
  'ABORT_ERR', 'AUTH', 'EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT', 'INVARIANT',
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'TIMEOUT', 'UNKNOWN',
])

export type RegistrationRefreshKind = 'none' | 'create' | 'update' | 'delete' | 'unchanged' | 'error'

export interface RefreshFailure {
  provider: string
  code: string
}

export interface RefreshReport {
  startedAt: number
  completedAt: number
  discoveredCount: number
  eligibleCount: number
  registrationKind: RegistrationRefreshKind
  addedModelIds: readonly string[]
  removedModelIds: readonly string[]
  failures: readonly RefreshFailure[]
}

export interface CreateRefreshReportInput {
  startedAt: number
  completedAt: number
  discoveredModelIds: readonly string[]
  eligibleModelIds: readonly string[]
  previousModelIds: readonly string[]
  registrationKind: RegistrationRefreshKind
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
    registrationKind: input.registrationKind,
    addedModelIds: discovered.filter((modelId) => !previous.has(modelId)),
    removedModelIds: sortedUnique(input.previousModelIds).filter((modelId) => !current.has(modelId)),
    failures: input.failures.map(({ provider, code }) => ({ provider, code: safeFailureCode(code) }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.code.localeCompare(right.code)),
  }
}
