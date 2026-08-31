import { candidateKey, type CandidateModel } from '../types.js'

export interface CatalogSource {
  load(signal: AbortSignal): Promise<readonly CandidateModel[]>
}

export class CatalogRegistry {
  constructor(private readonly sources: readonly CatalogSource[]) {}

  async refresh(
    executable: ReadonlyMap<string, ReadonlySet<string>>,
    signal: AbortSignal,
  ): Promise<CandidateModel[]> {
    const results = await Promise.allSettled(this.sources.map((source) => source.load(signal)))
    const groups = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const seen = new Set<string>()
    return groups.flat().filter((candidate) => {
      if (!executable.get(candidate.provider)?.has(candidate.model)) return false
      const key = candidateKey(candidate)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
