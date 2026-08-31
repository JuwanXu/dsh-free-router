import { tierFor } from './rankings.js'
import type { CandidateModel } from '../types.js'

const modelsEndpoint = 'https://openrouter.ai/api/v1/models'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface OpenRouterModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown } | null
  supported_parameters?: unknown
}

function zeroPrice(value: unknown): boolean {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed === 0
}

function modelFrom(value: OpenRouterModel, updatedAt: number): CandidateModel | undefined {
  if (typeof value.id !== 'string' || !value.id.endsWith(':free')) return undefined
  if (!value.pricing || !zeroPrice(value.pricing.prompt) || !zeroPrice(value.pricing.completion)) return undefined
  if (!Array.isArray(value.supported_parameters) || !value.supported_parameters.includes('tools')) return undefined
  const contextWindow = value.context_length
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined

  return {
    provider: 'openrouter',
    model: value.id,
    displayName: typeof value.name === 'string' && value.name.length > 0 ? value.name : value.id,
    contextWindow,
    toolCalling: true,
    free: true,
    tier: tierFor(value.id),
    catalogUpdatedAt: updatedAt,
  }
}

export class OpenRouterCatalogSource {
  readonly provider = 'openrouter'
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly endpoint = modelsEndpoint,
    private readonly now: () => number = Date.now,
  ) {}

  async load(signal: AbortSignal): Promise<CandidateModel[]> {
    const response = await this.fetchImpl(this.endpoint, { signal })
    if (!response.ok) throw new Error(`OpenRouter model directory returned HTTP ${response.status}`)
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error('OpenRouter model directory has an invalid response body')
    }
    const updatedAt = this.now()
    return (payload as { data: OpenRouterModel[] }).data
      .map((model) => modelFrom(model, updatedAt))
      .filter((model): model is CandidateModel => model !== undefined)
  }
}
