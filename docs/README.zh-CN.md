# DSH Free Router

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供免费模型的请求级自动路由与故障切换。它复用官方 `@deepseek-ai/dsh-llm-pi-ai` 进行实际调用，不注册虚拟 Provider，因此会话记录、usage 和错误始终保留真实的 `provider/model`。

## 能力范围

- 首版目录：NVIDIA NIM 静态验证清单与 OpenRouter 实时免费模型目录。
- 只选择免费、确认支持 tool calling、并满足上下文和 Tier 约束的模型。
- 每次主 Agent 请求按“可用性 → Tier → 首分片平均延迟 → 成功率”排序。
- 遇到 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、鉴权或配额等可恢复故障时，切换同一步尚未尝试过的候选。
- 每个 `turn/step` 默认最多尝试 4 个模型，并在 Session 中追加非 surface 的 `free-router/selected` 与 `free-router/failover` 事件。
- 不路由 session title、compaction 和其他辅助调用；它们也不参与健康指标。
- 不保存 API key、Authorization header 或原始请求。缓存只允许模型目录与健康摘要。

## 安装

前置条件：Node.js 22.19+、pnpm 11+，以及包含 `llm`、`agent`、`settings` 与 `@deepseek-ai/dsh-llm-pi-ai` 的完整 DSH profile。

从 npm 安装插件：

```bash
dsh plugin --profile web add dsh-free-router
```

如需从源码开发，在本仓库根目录构建后使用本地插件安装命令：

```bash
pnpm install
pnpm run build
dsh plugin --profile web add "file:$(pwd)"
```

然后在 DSH Models/Settings 中启用 `llm-pi-ai` 的 NVIDIA NIM 和/或 OpenRouter route，并通过环境变量或 DSH credentials 配置对应凭据。建议将两者的 adapter 内重试关掉，让本插件优先跨模型切换：

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

## 配置

插件在 DSH Settings 中注册 `free-router` 命名空间。下面是完整默认配置：

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

`route` 是 DSH 中 `llm-pi-ai` 实际注册的 Provider 路由名。`includeModels` 非空时是白名单；`excludeModels` 始终优先排除。没有合格候选或插件关闭时，请求保持原始 DSH 模型配置，不会阻塞对话。

## 故障处理与隐私

同一个 `turn/step` 不会重复尝试同一模型，默认最多尝试 4 个模型。`UNSUPPORTED_OPTION`、上下文溢出和无效请求会交回 DSH 下游处理，避免无意义地切换模型。连续故障采用指数冷却；鉴权、凭据与配额问题会隔离整个 Provider。

缓存记录保存在 `$DSH_HOME/cache/free-router.json`，使用白名单投影，仅含版本、时间、模型公开元数据与健康数值。过期缓存只用于冷启动排序提示，不会把模型标记为实时可用；凭据始终由 DSH 的 `llm-pi-ai`/credentials 能力管理。

## 开发与验证

```bash
pnpm run check
pnpm run test:integration
pnpm run test:smoke
```

不会在测试中调用真实模型或要求 API key。未来将新增配置驱动的任意 OpenAI-compatible Provider 目录源；该扩展不会改变当前的请求路由、排序或健康模型。

## 许可与归因

代码采用 [MIT](./LICENSE) 许可。模型 Tier 数据的来源和许可说明见 [data/ATTRIBUTION.md](./data/ATTRIBUTION.md)。

