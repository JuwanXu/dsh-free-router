import { describe, expect, it } from 'vitest'
import { planManagedRoute } from '../src/registration/managed-route.js'

const registration = { route: 'free-router-openrouter', displayName: 'Free Router · OpenRouter' }

const candidate = (model: string) => ({
  provider: 'openrouter',
  model,
  displayName: model.toUpperCase(),
  contextWindow: 65_536,
  toolCalling: true,
  free: true,
  tier: 'A',
  catalogUpdatedAt: 1,
})

const sourceProfile = {
  apiKeyEnv: 'OPENROUTER_API_KEY',
  baseURL: 'https://openrouter.ai/api/v1',
  api: 'openai-completions',
  retryPolicy: { mode: 'normal', maxRetries: 0 },
  displayName: 'Source Provider',
  models: [{ id: 'manual' }],
  modelOverrides: { manual: { contextWindow: 1 } },
  apiKey: 'must-not-copy',
}

describe('planManagedRoute', () => {
  it('projects only safe profile fields and catalog models', () => {
    const plan = planManagedRoute(sourceProfile, 'openrouter', registration, [candidate('b:free'), candidate('a:free')])

    expect(plan.profile).toMatchObject({
      apiKeyEnv: 'OPENROUTER_API_KEY',
      displayName: 'Free Router · OpenRouter',
      models: [{ id: 'a:free' }, { id: 'b:free' }],
    })
    expect(JSON.stringify(plan)).not.toContain('must-not-copy')
    expect(JSON.stringify(plan)).not.toContain('Source Provider')
    expect(JSON.stringify(plan)).not.toContain('modelOverrides')
    expect(plan.profile).not.toHaveProperty('modelOverrides')
  })

  it('creates equal plans regardless of catalog order', () => {
    expect(planManagedRoute(sourceProfile, 'openrouter', registration, [candidate('b:free'), candidate('a:free')]))
      .toEqual(planManagedRoute(sourceProfile, 'openrouter', registration, [candidate('a:free'), candidate('b:free')]))
  })

  it('does not mutate inputs', () => {
    const source = { headers: { 'X-Test': 'source' } }
    const models = [candidate('a:free')]
    planManagedRoute(source, 'openrouter', registration, models)
    expect(source).toEqual({ headers: { 'X-Test': 'source' } })
    expect(models).toEqual([candidate('a:free')])
  })

  it('safely copies own __proto__ JSON data and includes it in the signature', () => {
    const source = JSON.parse('{"headers":{"__proto__":{"injected":"value"}}}') as Record<string, unknown>
    const plan = planManagedRoute(source, 'openrouter', registration, [])
    const headers = plan.profile.headers as Record<string, unknown>

    expect(Object.getPrototypeOf(headers)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(headers, '__proto__')).toBe(true)
    expect(headers['__proto__']).toEqual({ injected: 'value' })
    expect(({} as Record<string, unknown>).injected).toBeUndefined()

    const changed = JSON.parse('{"headers":{"__proto__":{"injected":"changed"}}}') as Record<string, unknown>
    expect(plan.claim.profileSignature).not.toBe(planManagedRoute(changed, 'openrouter', registration, []).claim.profileSignature)
  })

  it('deduplicates equal model IDs deterministically across metadata and input order', () => {
    const first = { ...candidate('same:free'), displayName: 'Zulu', contextWindow: 32_768 }
    const second = { ...candidate('same:free'), displayName: 'Alpha', contextWindow: 65_536 }
    const forward = planManagedRoute(sourceProfile, 'openrouter', registration, [first, second])
    const reverse = planManagedRoute(sourceProfile, 'openrouter', registration, [second, first])

    expect(forward).toEqual(reverse)
    expect(forward.profile.models).toEqual([{ id: 'same:free', name: 'Alpha', contextWindow: 65_536 }])
  })
})
