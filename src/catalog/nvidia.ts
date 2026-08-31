import models from '../../data/nvidia-models.json' with { type: 'json' }
import type { CandidateModel, ModelTier } from '../types.js'

interface NvidiaModel {
  model: string
  displayName: string
  contextWindow: number
  tier: ModelTier
}

export class NvidiaCatalogSource {
  readonly provider = 'nvidia'
  constructor(private readonly now: () => number = Date.now) {}

  async load(_signal: AbortSignal): Promise<CandidateModel[]> {
    const updatedAt = this.now()
    return (models as NvidiaModel[]).map((model) => ({
      provider: 'nvidia',
      model: model.model,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      toolCalling: true,
      free: true,
      tier: model.tier,
      catalogUpdatedAt: updatedAt,
    }))
  }
}
