import { candidateKey, type CandidateModel } from '../types.js'

export interface CatalogSource {
  readonly provider?: string
  load(signal: AbortSignal): Promise<readonly CandidateModel[]>
}

export class CatalogRegistry {
  constructor(
    private readonly sources: readonly CatalogSource[],
    private readonly sourceTimeoutMs = 10_000,
  ) {}

  async discover(
    enabledProviders: ReadonlySet<string>,
    signal: AbortSignal,
    previous: readonly CandidateModel[] = [],
    onSourceFailure?: (provider: string) => void,
  ): Promise<CandidateModel[]> {
    const activeSources = this.sources.filter((source) => (
      source.provider === undefined || enabledProviders.has(source.provider)
    ))
    const results = await Promise.allSettled(activeSources.map((source) => this.loadSource(source, signal)))
    const failedProviders = new Set(results.flatMap((result, index) => (
      result.status === 'rejected' && activeSources[index]?.provider !== undefined
        ? [activeSources[index].provider]
        : []
    )))
    if (!signal.aborted) {
      for (const provider of failedProviders) onSourceFailure?.(provider)
    }
    const groups = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const retained = previous.filter((candidate) => failedProviders.has(candidate.provider))
    const seen = new Set<string>()
    return [...groups.flat(), ...retained].filter((candidate) => {
      const key = candidateKey(candidate)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  executable(
    candidates: readonly CandidateModel[],
    executable: ReadonlyMap<string, ReadonlySet<string>>,
  ): CandidateModel[] {
    const seen = new Set<string>()
    return candidates.filter((candidate) => {
      if (!executable.get(candidate.provider)?.has(candidate.model)) return false
      const key = candidateKey(candidate)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async refresh(
    executable: ReadonlyMap<string, ReadonlySet<string>>,
    signal: AbortSignal,
    previous: readonly CandidateModel[] = [],
    onSourceFailure?: (provider: string) => void,
  ): Promise<CandidateModel[]> {
    const results = await Promise.allSettled(this.sources.map((source) => (
      source.provider !== undefined && executable.get(source.provider)?.size === 0
        ? Promise.resolve([])
        : this.loadSource(source, signal)
    )))
    const failedProviders = new Set(results.flatMap((result, index) => (
      result.status === 'rejected' && this.sources[index]?.provider !== undefined
        ? [this.sources[index].provider]
        : []
    )))
    if (!signal.aborted) {
      for (const provider of failedProviders) onSourceFailure?.(provider)
    }
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

  private async loadSource(source: CatalogSource, signal: AbortSignal): Promise<readonly CandidateModel[]> {
    const timeoutController = new AbortController()
    const sourceSignal = AbortSignal.any([signal, timeoutController.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutController.abort(new DOMException('catalog source timed out', 'TimeoutError'))
        reject(new Error(`catalog source ${source.provider ?? 'unknown'} timed out after ${this.sourceTimeoutMs}ms`))
      }, this.sourceTimeoutMs)
    })
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('catalog refresh aborted', 'AbortError'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([source.load(sourceSignal), timeout, aborted])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}
