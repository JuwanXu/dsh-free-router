# DSH Free Router

[Chinese documentation](./docs/README.zh-CN.md)

A DeepSeek Harness plugin for request-level routing and failover across free models. It reuses the official `@deepseek-ai/dsh-llm-pi-ai` adapter for actual requests and never registers a virtual provider, so session history, usage, and errors always retain the real `provider/model`.

## Scope

- Initial catalog sources: a statically verified NVIDIA NIM list and the live OpenRouter free-model catalog.
- Selects only free models that are confirmed to support tool calling and satisfy the context-window and tier constraints.
- Ranks each primary-agent request by availability, tier, average first-token latency, then success rate.
- On recoverable `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, authentication, or quota failures, switches to an untried candidate in the same step.
- Attempts at most four models per `turn/step` by default and appends non-surface `free-router/selected` and `free-router/failover` events to the session.
- Does not route session titles, compaction, or other auxiliary calls; those calls do not affect health metrics.
- Never stores API keys, Authorization headers, or raw requests. The cache is limited to model catalog data and health summaries.

## Installation

Prerequisites: Node.js 22.19+, pnpm 11+, and a full DSH profile that includes `llm`, `agent`, `settings`, and `@deepseek-ai/dsh-llm-pi-ai`.

Install from npm:

```bash
dsh plugin --profile web add dsh-free-router
```

For local development, build the repository root and install it as a local plugin:

```bash
pnpm install
pnpm run build
dsh plugin --profile web add "file:$(pwd)"
```

Then enable the NVIDIA NIM and/or OpenRouter routes in DSH `llm-pi-ai`, and provide credentials through environment variables or DSH credentials. Disable adapter-level retries so this plugin can perform cross-model failover first:

```yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      retryPolicy: { mode: normal, maxRetries: 0 }
    nvidia:
      apiKeyEnv: NVIDIA_API_KEY
      retryPolicy: { mode: normal, maxRetries: 0 }
```

## Configuration

The plugin registers the `free-router` namespace in DSH Settings. Its complete default configuration is:

```yaml
free-router:
  enabled: true
  providers:
    openrouter: { enabled: true, route: openrouter }
    nvidia: { enabled: true, route: nvidia }
  routing:
    maxAttemptsPerStep: 4
    minimumContextWindow: 32768
    minimumTier: B
    includeModels: []
    excludeModels: []
  health:
    timeoutMs: 6000
    concurrency: 4
    activeProbeIntervalMs: 60000
    idleProbeIntervalMs: 600000
    maxCandidatesPerProvider: 8
```

`route` must match the actual provider route registered by DSH `llm-pi-ai`. A non-empty `includeModels` list acts as an allowlist, while `excludeModels` always takes precedence. If the plugin is disabled or no eligible candidate exists, the request keeps the original DSH model configuration and is not blocked.

### Dynamic OpenRouter registration

Set up an OpenRouter source route and enable the managed route below to keep the eligible free, tool-capable models in the DSH model picker:

```yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      baseURL: https://openrouter.ai/api/v1
      retryPolicy: { mode: normal, maxRetries: 0 }

free-router:
  enabled: true
  providers:
    openrouter: { enabled: true, route: openrouter }
    nvidia: { enabled: true, route: nvidia }
  registration:
    openrouter:
      enabled: true
      route: free-router-openrouter
      displayName: Free Router · OpenRouter
  routing:
    maxAttemptsPerStep: 4
    minimumContextWindow: 32768
    minimumTier: B
    includeModels: []
    excludeModels: []
  health:
    timeoutMs: 6000
    concurrency: 4
    activeProbeIntervalMs: 60000
    idleProbeIntervalMs: 600000
    maxCandidatesPerProvider: 8
```

After the first successful catalog refresh, DSH shows `Free Router · OpenRouter` in its model dropdown. Its registered models are real OpenRouter models and can be selected as the default model. The original `openrouter` route remains available. Setting `registration.openrouter.enabled` to `false` stops synchronization and leaves the managed route in place; it does not delete that route or its last model list.

## Failure Handling and Privacy

A model is never attempted twice in the same `turn/step`, and there are at most four attempts by default. `UNSUPPORTED_OPTION`, context overflow, and invalid requests are delegated to DSH downstream handling to avoid pointless switching. Consecutive failures use exponential cooldown; authentication, credential, and quota failures isolate the entire provider.

The cache is stored at `$DSH_HOME/cache/free-router.json` and uses an allowlisted projection that contains only version, timestamps, public model metadata, and health values. An expired cache is used only as a cold-start ranking hint and never marks a model as currently available. Credentials remain exclusively managed by DSH `llm-pi-ai` and credentials services.

## Development and Verification

```bash
pnpm run check
pnpm run test:integration
pnpm run test:smoke
```

Tests neither call real models nor require API keys. A future extension will add configuration-driven catalog sources for arbitrary OpenAI-compatible providers without changing the existing routing, ranking, or health model.

## License and Attribution

The code is released under the [MIT](./LICENSE) license. See [data/ATTRIBUTION.md](./data/ATTRIBUTION.md) for model-tier data sources and license notices.
