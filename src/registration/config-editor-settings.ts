export interface SettingsMutation {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

export interface RegistrationSettings {
  get(namespace: string): unknown
  mutate(namespace: string, operations: readonly SettingsMutation[]): Promise<void>
}

interface ConfigEntry {
  options?: { id?: unknown }
  fiber?: {
    config?: { providers?: { get?: () => unknown } }
    runtime?: { Config?: (input: unknown) => { providers?: { get?: () => unknown } } }
  }
}

interface ConfigLayers {
  entry: ConfigEntry
  inherited: Record<string, unknown>
  override: Record<string, unknown>
}

export interface ConfigEditor {
  entries(): readonly ConfigEntry[]
  configuration?(): readonly ConfigLayers[]
  edit(
    entry: ConfigEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function providerEntry(editor: ConfigEditor): ConfigEntry | undefined {
  return editor.entries().find((entry) => entry.options?.id === 'llm-pi-ai')
}

function mergeLayers(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return structuredClone(override)
  const merged: Record<string, unknown> = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    merged[key] = Object.prototype.hasOwnProperty.call(merged, key)
      ? mergeLayers(merged[key], value)
      : structuredClone(value)
  }
  return merged
}

function configInput(editor: ConfigEditor, entry: ConfigEntry, raw: Record<string, unknown>): Record<string, unknown> {
  const layers = editor.configuration?.().find((row) => row.entry.options?.id === 'llm-pi-ai')
  if (layers === undefined) return { providers: raw }
  return mergeLayers(layers.inherited, layers.override) as Record<string, unknown>
}

function profiles(editor: ConfigEditor, entry: ConfigEntry | undefined): Record<string, unknown> | undefined {
  const raw = entry?.fiber?.config?.providers?.get?.()
  if (entry === undefined || !isRecord(raw)) return undefined
  const layers = editor.configuration?.().find((row) => row.entry.options?.id === 'llm-pi-ai')
  if (layers !== undefined) {
    const persisted = configInput(editor, entry, raw).providers
    if (isRecord(persisted)) return persisted
  }
  let value = raw
  try {
    const normalized = entry.fiber?.runtime?.Config?.(configInput(editor, entry, raw))?.providers?.get?.()
    if (isRecord(normalized)) value = normalized
  } catch {
    // Keep the live raw profile visible when a host cannot normalize it yet.
  }
  return isRecord(value) ? value : undefined
}

function applyOperations(value: Record<string, unknown>, operations: readonly SettingsMutation[]): Record<string, unknown> {
  const next = structuredClone(value)
  for (const operation of operations) {
    if (operation.path.length === 0) continue
    let parent: Record<string, unknown> = next
    for (const segment of operation.path.slice(0, -1)) {
      const child = parent[segment]
      if (!isRecord(child)) parent[segment] = {}
      parent = parent[segment] as Record<string, unknown>
    }
    const key = operation.path.at(-1)!
    if (operation.op === 'unset') delete parent[key]
    else parent[key] = structuredClone(operation.value)
  }
  return next
}

/** Adapt DSH 0.2's configEditor service to the router's managed-profile store. */
export function createConfigEditorRegistrationSettings(editor: ConfigEditor): RegistrationSettings {
  return {
    get(namespace) {
      if (namespace !== 'llm-pi-ai') return undefined
      const currentProfiles = profiles(editor, providerEntry(editor))
      return currentProfiles === undefined ? undefined : { providers: currentProfiles }
    },
    async mutate(namespace, operations) {
      if (namespace !== 'llm-pi-ai') throw new Error(`Unsupported settings namespace: ${namespace}`)
      const entry = providerEntry(editor)
      const currentProfiles = profiles(editor, entry)
      if (entry === undefined || currentProfiles === undefined) throw new Error('llm-pi-ai configuration is unavailable')
      await editor.edit(entry, (current) => {
        const next = applyOperations({ providers: currentProfiles }, operations)
        return { ...current, ...next }
      })
    },
  }
}
