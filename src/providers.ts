import { NvidiaCatalogSource } from './catalog/nvidia.js'
import { OpenRouterCatalogSource } from './catalog/openrouter.js'
import type { CatalogSource } from './catalog/registry.js'
import type { CatalogConfig } from './config.js'

export interface ProviderConfig {
  enabled: boolean
  route: string
}

/** 集中声明模型目录标识、默认路由与目录源工厂。 */
export const providerDescriptors = [
  {
    key: 'openrouter',
    source: 'openrouter',
    dynamicRegistration: true,
    config: { enabled: true, route: 'openrouter' },
    createCatalog: (catalog: CatalogConfig): CatalogSource => new OpenRouterCatalogSource(fetch, undefined, undefined, undefined, catalog.zeroPricedWithoutSuffix),
  },
  {
    key: 'nvidia',
    source: 'nvidia',
    dynamicRegistration: false,
    config: { enabled: true, route: 'nvidia' },
    createCatalog: (_catalog: CatalogConfig): CatalogSource => new NvidiaCatalogSource(),
  },
] as const

export type ProviderKey = typeof providerDescriptors[number]['key']

export function defaultProviderConfigs(): Record<ProviderKey, ProviderConfig> {
  return Object.fromEntries(providerDescriptors.map(({ key, config }) => [key, { ...config }])) as Record<ProviderKey, ProviderConfig>
}

export function providerCatalogSources(catalog: CatalogConfig = { zeroPricedWithoutSuffix: true }): CatalogSource[] {
  return providerDescriptors.map(({ createCatalog }) => createCatalog(catalog))
}
