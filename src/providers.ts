import { NvidiaCatalogSource } from './catalog/nvidia.js'
import { OpenRouterCatalogSource } from './catalog/openrouter.js'
import type { CatalogSource } from './catalog/registry.js'

export interface ProviderConfig {
  enabled: boolean
  route: string
}

/** 集中声明模型目录标识、默认路由与目录源工厂。 */
export const providerDescriptors = [
  {
    key: 'openrouter',
    source: 'openrouter',
    config: { enabled: true, route: 'openrouter' },
    createCatalog: (): CatalogSource => new OpenRouterCatalogSource(),
  },
  {
    key: 'nvidia',
    source: 'nvidia',
    config: { enabled: true, route: 'nvidia' },
    createCatalog: (): CatalogSource => new NvidiaCatalogSource(),
  },
] as const

export type ProviderKey = typeof providerDescriptors[number]['key']

export function defaultProviderConfigs(): Record<ProviderKey, ProviderConfig> {
  return Object.fromEntries(providerDescriptors.map(({ key, config }) => [key, { ...config }])) as Record<ProviderKey, ProviderConfig>
}

export function providerCatalogSources(): CatalogSource[] {
  return providerDescriptors.map(({ createCatalog }) => createCatalog())
}
