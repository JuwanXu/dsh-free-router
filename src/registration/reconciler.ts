import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { ManagedRouteClaim, ManagedRoutePlan } from './types.js'

export type ReconcileResult = {
  kind: 'create' | 'update' | 'unchanged'
  ops: SettingsPathOp[]
  claim: ManagedRouteClaim
} | {
  kind: 'conflict'
  reason: 'target-exists' | 'ownership-mismatch'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepJsonEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepJsonEqual(left[key], right[key]))
}

function staticProfilesEqual(existing: unknown, planned: Record<string, unknown>): boolean {
  if (!isRecord(existing)) return false
  const existingKeys = Object.keys(existing).filter((key) => key !== 'models').sort()
  const plannedKeys = Object.keys(planned).filter((key) => key !== 'models').sort()
  return existingKeys.length === plannedKeys.length
    && existingKeys.every((key, index) => key === plannedKeys[index]
      && deepJsonEqual(existing[key], planned[key]))
}

function matchingClaim(previous: ManagedRouteClaim, next: ManagedRouteClaim): boolean {
  return previous.sourceRoute === next.sourceRoute
    && previous.targetRoute === next.targetRoute
    && previous.profileSignature === next.profileSignature
}

export function reconcileManagedRoute(
  providers: Record<string, unknown>,
  plan: ManagedRoutePlan,
  previousClaim: ManagedRouteClaim | undefined,
): ReconcileResult {
  const targetExists = Object.prototype.hasOwnProperty.call(providers, plan.targetRoute)
  if (!targetExists) {
    return {
      kind: 'create',
      ops: [{ op: 'set', path: ['providers', plan.targetRoute], value: plan.profile }],
      claim: plan.claim,
    }
  }
  if (previousClaim === undefined || !matchingClaim(previousClaim, plan.claim)) {
    return { kind: 'conflict', reason: 'target-exists' }
  }

  const existing = providers[plan.targetRoute]
  if (!staticProfilesEqual(existing, plan.profile)) {
    return { kind: 'conflict', reason: 'ownership-mismatch' }
  }
  if (deepJsonEqual(isRecord(existing) ? existing.models : undefined, plan.profile.models)) {
    return { kind: 'unchanged', ops: [], claim: plan.claim }
  }
  return {
    kind: 'update',
    ops: [{ op: 'set', path: ['providers', plan.targetRoute, 'models'], value: plan.profile.models }],
    claim: plan.claim,
  }
}
