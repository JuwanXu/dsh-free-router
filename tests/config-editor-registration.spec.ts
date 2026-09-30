import { describe, expect, it } from 'vitest'
import { createConfigEditorRegistrationSettings } from '../src/registration/config-editor-settings.js'

describe('config-editor managed registration settings', () => {
  it('prefers persisted configuration layers over runtime-injected provider defaults', () => {
    const persisted = {
      providers: {
        openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' },
        'free-router-openrouter': { apiKeyEnv: 'OPENROUTER_API_KEY', models: [] },
      },
    }
    const runtimeProfiles = {
      openrouter: { ...persisted.providers.openrouter, headers: {}, modelOverrides: {} },
      'free-router-openrouter': { ...persisted.providers['free-router-openrouter'], headers: {}, modelOverrides: {} },
    }
    const settings = createConfigEditorRegistrationSettings({
      entries: () => [{
        options: { id: 'llm-pi-ai' },
        fiber: { config: { providers: { get: () => runtimeProfiles } } },
      }],
      configuration: () => [{
        entry: { options: { id: 'llm-pi-ai' }, fiber: { config: { providers: { get: () => runtimeProfiles } } }, },
        inherited: {},
        override: persisted,
      }],
      edit: async () => {},
    })

    expect(settings.get('llm-pi-ai')).toEqual(persisted)
  })

  it('uses the llm-pi-ai runtime Config to read normalized provider profiles', () => {
    const rawProfiles = { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } }
    const inherited = {
      providers: {
        openrouter: {
          baseURL: 'https://openrouter.ai/api/v1',
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        },
      },
    }
    const normalizedProfiles = { openrouter: { ...inherited.providers.openrouter, ...rawProfiles.openrouter } }
    const settings = createConfigEditorRegistrationSettings({
      entries: () => [{
        options: { id: 'llm-pi-ai' },
        fiber: {
          config: { providers: { get: () => rawProfiles } },
          runtime: { Config: (input: unknown) => ({ providers: { get: () => (input as { providers: Record<string, unknown> }).providers } }) },
        },
      }],
      configuration: () => [{
        entry: { options: { id: 'llm-pi-ai' } },
        inherited,
        override: { providers: rawProfiles },
      }],
      edit: async () => {},
    })

    expect(settings.get('llm-pi-ai')).toEqual({ providers: normalizedProfiles })
  })

  it('reads the live llm-pi-ai provider profiles and persists a managed route', async () => {
    let active: { providers: Record<string, unknown> } = {
      providers: {
        openrouter: {
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseURL: 'https://openrouter.ai/api/v1',
        },
      },
    }
    const editor = {
      entries: () => [{
        options: { id: 'llm-pi-ai' },
        fiber: { config: { providers: { get: () => active.providers } } },
      }],
      edit: async (_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
        active = change(active, {}) as typeof active
      },
    }

    const settings = createConfigEditorRegistrationSettings(editor)

    expect(settings.get('llm-pi-ai')).toEqual(active)

    await settings.mutate('llm-pi-ai', [{
      op: 'set',
      path: ['providers', 'free-router-openrouter'],
      value: {
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ id: 'stealth/space-bunny-alpha', name: 'Space Bunny', contextWindow: 1_000_000 }],
      },
    }])

    expect(active.providers['free-router-openrouter']).toMatchObject({
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: [{ id: 'stealth/space-bunny-alpha' }],
    })
    expect(active.providers.openrouter).toMatchObject({ baseURL: 'https://openrouter.ai/api/v1' })
  })
})
