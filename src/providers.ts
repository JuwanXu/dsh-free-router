import { NvidiaCatalogSource } from './catalog/nvidia.js'
import { OpenRouterCatalogSource } from './catalog/openrouter.js'
import type { CatalogSource } from './catalog/registry.js'
import type { RouterConfig, ProviderConfig } from './config.js'

/** One place to declare catalog identity, configured route, and source factory. */
export const providerDescriptors = [
  {
    key: 'openrouter',
    source: 'openrouter',
    createCatalog: (): CatalogSource => new OpenRouterCatalogSource(),
  },
  {
    key: 'nvidia',
    source: 'nvidia',
    createCatalog: (): CatalogSource => new NvidiaCatalogSource(),
  },
] as const

export type ProviderKey = typeof providerDescriptors[number]['key']

export function providerConfig(config: RouterConfig, key: ProviderKey): ProviderConfig {
  return config.providers[key]
}

export function providerCatalogSources(): CatalogSource[] {
  return providerDescriptors.map(({ createCatalog }) => createCatalog())
}
