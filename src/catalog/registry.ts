import { candidateKey, type CandidateModel } from '../types.js'

export interface CatalogSource {
  readonly provider?: string
  load(signal: AbortSignal): Promise<readonly CandidateModel[]>
}

export class CatalogRegistry {
  constructor(private readonly sources: readonly CatalogSource[]) {}

  async refresh(
    executable: ReadonlyMap<string, ReadonlySet<string>>,
    signal: AbortSignal,
    previous: readonly CandidateModel[] = [],
  ): Promise<CandidateModel[]> {
    const results = await Promise.allSettled(this.sources.map((source) => source.load(signal)))
    const failedProviders = new Set(results.flatMap((result, index) => (
      result.status === 'rejected' && this.sources[index]?.provider !== undefined
        ? [this.sources[index].provider]
        : []
    )))
    const groups = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const retained = previous.filter((candidate) => failedProviders.has(candidate.provider))
    const seen = new Set<string>()
    return [...groups.flat(), ...retained].filter((candidate) => {
      if (!executable.get(candidate.provider)?.has(candidate.model)) return false
      const key = candidateKey(candidate)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
