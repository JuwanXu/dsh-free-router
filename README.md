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
  catalog:
    zeroPricedWithoutSuffix: true
  providers:
    openrouter: { enabled: true, route: openrouter }
    nvidia: { enabled: true, route: nvidia }
  routing:
    maxAttemptsPerStep: 4
    minimumContextWindow: 32768
    minimumTier: '?'
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

After the first successful catalog refresh, DSH shows `Free Router · OpenRouter` in its model dropdown. Its registered models are real OpenRouter models and can be selected as the default model. The original `openrouter` route remains available. The meta-router model `openrouter/free` is deliberately excluded; configure the underlying free models directly. Setting `registration.openrouter.enabled` to `false` stops synchronization and leaves the managed route in place; it does not delete that route or its last model list.

The catalog accepts models with zero prompt and completion prices even when their IDs lack a `:free` suffix. Set `catalog.zeroPricedWithoutSuffix: false` to restore the previous suffix-only rule. By default, `routing.minimumTier: '?'` allows models without a curated tier rating; choose a stricter tier to narrow the candidates. You can also explicitly exclude IDs such as `openrouter/free` with `routing.excludeModels` (the meta-router itself remains excluded regardless).

In a DSH session, `/free-router refresh` runs discovery, eligibility filtering, managed-route reconciliation, and cache update, then reports counts, registration result, model additions/removals, and safe failure codes. `/free-router status` shows the last report without starting network work; before the first refresh it reports `no refresh report`.

### Using it with Camel and Continue

`dsh-free-router`, `dsh-camel`, and `dsh-continue` can be installed in the same DSH profile. Give each failure class one owner:

- **Free Router** owns `RATE_LIMIT` for free-model requests. It marks the failed model unhealthy and retries the step with a different eligible model.
- **Camel** may still pace requests, but its retry policy must exclude `RATE_LIMIT`; otherwise Camel retries the same model before Free Router can switch it.
- **Continue** should own only transient network failures such as `TIMEOUT`, `TRANSPORT`, and `SERVER`.

For the common three-plugin setup, keep Camel throttling enabled and disable its rate-limit retry:

```yaml
# DSH profile patch for the camel plugin
- id: camel
  config:
    defaults:
      throttle:
        enabled: true
        maxRequests: 5
        windowMs: 60000
        scope: route
      retry:
        enabled: false
```

An OpenRouter `RATE_LIMIT` can be model-specific or account-wide. The router can recover from a model-specific limit when another eligible model is available. It cannot bypass OpenRouter's account-wide free-model quota: when every candidate receives the same quota error, wait for the provider reset or add provider credit.

### Manual verification

Start the Web profile normally and open the authenticated URL printed by DSH:

```bash
dsh --profile web --host 127.0.0.1 --port 3082
```

Do not open a bare `http://127.0.0.1:3082/` URL in a different browser context; DSH Web protects its API with a per-process browser token. In the authenticated page, select `Free Router · OpenRouter`, create a new session, and send a short request. The model picker should list the dynamically registered free models.

## Failure Handling and Privacy

A model is never attempted twice in the same `turn/step`, and there are at most four attempts by default. `UNSUPPORTED_OPTION`, context overflow, and invalid requests are delegated to DSH downstream handling to avoid pointless switching. Consecutive failures use exponential cooldown; authentication, credential, and quota failures isolate the entire provider.

The cache is stored at `$DSH_HOME/cache/free-router.json` and uses an allowlisted projection that contains only version, timestamps, public model metadata, and health values. An expired cache is used only as a cold-start ranking hint and never marks a model as currently available. Credentials remain exclusively managed by DSH `llm-pi-ai` and credentials services. Some stealth/cloaked models with zero prices may be logged by their provider or used for training; enabling discovery makes them eligible for routing, so review provider terms and exclude any model you do not want to use.

### Desktop release candidate

For DSH Desktop `0.2.0-rc.2`, install a locally packed build into a temporary profile and explicitly accept the exact package-version compatibility exception:

```bash
pnpm run check
pnpm pack
dsh plugin --profile <temporary-profile> allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile <temporary-profile> add file:/absolute/path/dsh-free-router-0.1.3.tgz
```

Open the Desktop app with that profile and run `/free-router refresh` to verify it. See the [author-only release checklist](./docs/release-checklist.md); only the package author should publish.

## Development and Verification

```bash
pnpm run check
pnpm run test:integration
pnpm run test:smoke
```

Tests neither call real models nor require API keys. A future extension will add configuration-driven catalog sources for arbitrary OpenAI-compatible providers without changing the existing routing, ranking, or health model.

## License and Attribution

The code is released under the [MIT](./LICENSE) license. See [data/ATTRIBUTION.md](./data/ATTRIBUTION.md) for model-tier data sources and license notices.
