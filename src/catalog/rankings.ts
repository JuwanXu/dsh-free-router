import rankings from '../../data/model-rankings.json' with { type: 'json' }
import type { ModelTier } from '../types.js'

export function tierFor(model: string): ModelTier {
  return (rankings[model as keyof typeof rankings] ?? '?') as ModelTier
}
