import { describe, expect, it } from 'vitest'
import { reconcileManagedRoute } from '../src/registration/reconciler.js'
import type { ManagedRouteClaim, ManagedRoutePlan } from '../src/registration/types.js'

const claim: ManagedRouteClaim = {
  sourceRoute: 'openrouter',
  targetRoute: 'free-router-openrouter',
  profileSignature: 'opaque-profile-signature',
  modelIds: ['first:free'],
}

const plan = (models = [{ id: 'first:free', name: 'First Free', contextWindow: 65_536 }]): ManagedRoutePlan => ({
  targetRoute: 'free-router-openrouter',
  profile: {
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    displayName: 'Free Router · OpenRouter',
    models,
  },
  claim: { ...claim, modelIds: models.map((model) => model.id) },
})

const existingManagedProviders = {
  'free-router-openrouter': plan().profile,
}

describe('reconcileManagedRoute', () => {
  it('creates a missing target with one provider-path operation', () => {
    expect(reconcileManagedRoute({}, plan(), undefined)).toEqual({
      kind: 'create',
      ops: [{ op: 'set', path: ['providers', 'free-router-openrouter'], value: plan().profile }],
      claim,
    })
  })

  it('does not overwrite an unmanaged target', () => {
    expect(reconcileManagedRoute({
      'free-router-openrouter': { apiKeyEnv: 'OTHER_KEY', models: [{ id: 'keep-me' }] },
    }, plan(), undefined)).toEqual({ kind: 'conflict', reason: 'target-exists' })
  })

  it('requires the opaque profile signature before accepting a prior claim', () => {
    expect(reconcileManagedRoute(existingManagedProviders, plan(), {
      ...claim,
      profileSignature: 'different-opaque-value',
    })).toEqual({ kind: 'conflict', reason: 'target-exists' })
  })

  it('rejects a changed static profile for a claimed target', () => {
    expect(reconcileManagedRoute({
      'free-router-openrouter': { ...plan().profile, apiKeyEnv: 'OTHER_KEY' },
    }, plan(), claim)).toEqual({ kind: 'conflict', reason: 'ownership-mismatch' })
  })

  it('does not mutate an already matching managed route', () => {
    expect(reconcileManagedRoute(existingManagedProviders, plan(), claim)).toEqual({
      kind: 'unchanged',
      ops: [],
      claim,
    })
  })

  it('writes only the managed models path on a valid update', () => {
    const changedPlan = plan([
      { id: 'first:free', name: 'First Free', contextWindow: 65_536 },
      { id: 'second:free', name: 'Second Free', contextWindow: 32_768 },
    ])
    const result = reconcileManagedRoute(existingManagedProviders, changedPlan, claim)

    expect(result).toMatchObject({ kind: 'update', claim: changedPlan.claim })
    expect(result.kind === 'conflict' ? [] : result.ops).toEqual([{
      op: 'set',
      path: ['providers', 'free-router-openrouter', 'models'],
      value: changedPlan.profile.models,
    }])
  })
})
