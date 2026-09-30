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

`route` 是 DSH 中 `llm-pi-ai` 实际注册的 Provider 路由名。`includeModels` 非空时是白名单；`excludeModels` 始终优先排除。没有合格候选或插件关闭时，请求保持原始 DSH 模型配置，不会阻塞对话。

### 动态登记 OpenRouter 免费模型

将 `openrouter` 作为来源路由，并启用下面的 `registration`，即可把合格的 OpenRouter 免费工具模型自动登记到 DSH 模型选择器：

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

目录首次成功刷新后，DSH 下拉列表会出现 `Free Router · OpenRouter`，其中的模型可以设为默认模型。原始 `openrouter` 路由不会被改写；只有同时满足免费、支持工具调用、上下文窗口和 Tier 要求的模型才会出现。元路由模型 `openrouter/free` 会被刻意排除，建议直接配置底层免费模型。若目标路由已被其他配置占用，注册会停用并保留原配置，请把 `registration.openrouter.route` 改成其他名称后重试。目录短暂失败时，会保留上一份成功登记的模型列表。将 `registration.openrouter.enabled` 设为 `false` 只停止同步，不会删除托管路由或其最后一份模型列表。

默认 `catalog.zeroPricedWithoutSuffix: true` 会接受 prompt 与 completion 价格都为零的模型，即使 ID 没有 `:free` 后缀；设为 `false` 会恢复只接受 `:free` 后缀的旧规则。默认 `routing.minimumTier: '?'` 会允许尚无整理 Tier 的模型；可改成更严格等级缩小候选范围。也可通过 `routing.excludeModels` 排除指定 ID（`openrouter/free` 无论如何都会排除）。

在 DSH 会话中，`/free-router refresh` 会执行发现、资格筛选、托管路由同步和缓存更新，并返回数量、登记结果、模型增删及安全失败码。`/free-router status` 只显示最近报告，不会发起网络刷新；首次刷新前显示 `no refresh report`。

### 与 Camel、Continue 组合使用

`dsh-free-router`、`dsh-camel` 与 `dsh-continue` 可以安装到同一份 DSH profile，但同一类故障只能由一个插件接管：

- **Free Router** 负责免费模型请求的 `RATE_LIMIT`：记录当前模型不可用，并在同一步切换到另一个合格候选。
- **Camel** 可以继续进行请求节流，但其重试策略必须不接管 `RATE_LIMIT`；否则 Camel 会在 Free Router 切换前对同一模型反复重试。
- **Continue** 仅处理 `TIMEOUT`、`TRANSPORT`、`SERVER` 等临时网络故障。

推荐的三插件组合配置是保留 Camel 节流、关闭其限流重试：

```yaml
# DSH profile 中 camel 插件的 patch 配置
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

OpenRouter 的 `RATE_LIMIT` 可能是单模型限流，也可能是账户级免费模型配额耗尽。前者存在其他合格候选时会自动切换；后者会让所有免费候选都收到同一错误，路由无法绕过，需要等待供应商额度重置或为账户充值。

### 手工验证

通过 DSH 正常启动 Web profile，并使用启动时打印的带认证地址打开页面：

```bash
dsh --profile web --host 127.0.0.1 --port 3082
```

不要在另一个浏览器上下文直接打开裸地址 `http://127.0.0.1:3082/`。DSH Web 使用进程级浏览器令牌保护 API；认证页面中选择 `Free Router · OpenRouter`、新建会话并发送一条简短请求后，模型选择器应展示动态登记的免费模型。

## 故障处理与隐私

同一个 `turn/step` 不会重复尝试同一模型，默认最多尝试 4 个模型。`UNSUPPORTED_OPTION`、上下文溢出和无效请求会交回 DSH 下游处理，避免无意义地切换模型。连续故障采用指数冷却；鉴权、凭据与配额问题会隔离整个 Provider。

缓存记录保存在 `$DSH_HOME/cache/free-router.json`，使用白名单投影，仅含版本、时间、模型公开元数据与健康数值。过期缓存只用于冷启动排序提示，不会把模型标记为实时可用；凭据始终由 DSH 的 `llm-pi-ai`/credentials 能力管理。部分 stealth/cloaked 零价格模型可能被提供方记录或用于训练；开启发现意味着这类模型可进入路由候选，请先确认提供方条款，并排除不希望使用的模型。

### Desktop 候选版本验证

在 DSH Desktop `0.2.0-rc.2` 中，可将本地打包产物安装到临时 profile，并明确接受精确的版本兼容例外：

```bash
pnpm run check
pnpm pack
dsh plugin --profile <temporary-profile> allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile <temporary-profile> add file:/absolute/path/dsh-free-router-0.1.3.tgz
```

使用该 profile 打开 Desktop App 并运行 `/free-router refresh` 验证。发布步骤仅供作者执行，见[作者发布检查清单](./release-checklist.md)。

## 开发与验证

```bash
pnpm run check
pnpm run test:integration
pnpm run test:smoke
```

不会在测试中调用真实模型或要求 API key。未来将新增配置驱动的任意 OpenAI-compatible Provider 目录源；该扩展不会改变当前的请求路由、排序或健康模型。

## 许可与归因

代码采用 [MIT](./LICENSE) 许可。模型 Tier 数据的来源和许可说明见 [data/ATTRIBUTION.md](./data/ATTRIBUTION.md)。
