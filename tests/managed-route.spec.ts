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
  models: [{ id: 'manual' }],
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
})
