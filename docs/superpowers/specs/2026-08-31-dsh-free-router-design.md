# DSH Free Router 设计规范

## 1. 背景与目标

本项目提供一个独立、可安装、可发布的 DeepSeek Harness（DSH）社区插件，为主 Agent 的每次模型请求动态选择当前最合适的免费模型。首版支持 NVIDIA NIM 与 OpenRouter，复用 DSH 官方 `@deepseek-ai/dsh-llm-pi-ai` 完成真实模型请求，不自行实现 LLM 协议适配。

插件的核心目标是：

- 只路由到免费且确认支持 tool calling 的模型。
- 在每次主 Agent 请求前选择真实的 `provider/model`。
- 遇到限流、服务端错误、超时或传输故障时切换到其他候选模型。
- 按“可用性、模型 Tier、平均延迟、成功率”的顺序选择候选。
- 使用 DSH 原生 Settings、Models 与 credentials 能力，不保存私有密钥文件。
- 为后续任意 OpenAI-compatible Provider 保留配置驱动的扩展边界。

首版不提供独立 Web 状态面板，不路由 session title、compaction 等辅助模型调用，也不支持缺少 DSH base 能力的精简 SDK profile。

## 2. 已确认的产品决策

| 主题 | 决策 |
|---|---|
| 路由粒度 | 每次主 Agent 模型请求 |
| 首版 Provider | NVIDIA NIM、OpenRouter |
| 后续扩展 | 任意 OpenAI-compatible Provider |
| 用户界面 | 后台自动路由 + DSH Settings/Models |
| 排序策略 | 可用性 → Tier → 平均延迟 → 成功率 |
| 候选能力 | 免费且支持 tool calling |
| 发布形态 | 独立可安装的社区插件仓库 |
| LLM 执行 | 复用 `llm-pi-ai` |

## 3. 方案选择

### 3.1 采用方案

采用“路由策略插件 + 复用 `llm-pi-ai`”。插件通过 DSH 的 `agent/request` waterfall 改写每次调用的 `provider/model`，通过 `agent/request-error` waterfall 处理跨模型故障切换。工具调用、流式输出、图片、取消、usage、凭据解析和 replay state 均由官方适配器负责。

路由器不注册 `free-router/auto` 之类的虚拟 LLM adapter。因此 request header、assistant message source、usage 和错误归属始终记录真实 Provider 与模型。

### 3.2 未采用方案

- **虚拟 Provider adapter**：会让持久记录中的 Provider/模型身份失真，并增加跨 adapter 委托、递归 waterfall 与 replay state 归属风险。
- **自行实现 OpenRouter/NVIDIA adapter**：会重复实现 DSH 已有的 SSE、工具调用、取消、错误转换和回放逻辑，兼容与维护成本过高。

## 4. 总体架构

插件由以下六个边界清晰的模块组成：

1. **CatalogSource**：获取 Provider 的候选模型目录。
2. **EligibilityPolicy**：判断模型是否免费、支持 tools，并满足用户配置的容量与名单约束。
3. **ModelRankingStore**：提供 Tier 等静态质量信息。
4. **HealthMonitor**：维护滚动延迟、成功率、连续失败与冷却状态。
5. **RoutingPolicy**：从候选快照产生稳定、有序的路由结果。
6. **RouterPlugin**：接入 Cordis/DSH 生命周期、waterfall、Settings、会话事件和持久化能力。

领域模块不依赖 DSH。只有插件入口和 runtime 适配层导入 Cordis/DSH 类型，使目录发现、资格判断、指标与排序能够脱离 Harness 做确定性测试。

统一候选结构至少包含：

```ts
interface CandidateModel {
  provider: string
  model: string
  displayName: string
  contextWindow: number
  toolCalling: true
  free: true
  tier: ModelTier
  catalogUpdatedAt: number
}
```

未来的 `OpenAICompatibleCatalogSource` 产生相同结构，因此无需修改健康监控或排序策略。

## 5. 模型目录与资格判断

### 5.1 OpenRouter

`OpenRouterCatalogSource` 使用 OpenRouter 实时模型目录。模型必须同时满足以下条件：

- 价格元数据表明输入和输出均为零成本。
- 模型 ID 或 Provider 路由符合 OpenRouter 免费模型约定；价格与免费路由标记需要交叉校验，避免只依赖命名规则。
- 能力元数据明确包含 tool calling 所需参数。
- 上下文窗口不低于 `minimumContextWindow`。
- 未被 `excludeModels` 排除，并在非空 `includeModels` 中被允许。

目录刷新失败时保留最后有效快照。没有缓存的首次启动不会因 OpenRouter 失败而阻止 NVIDIA 候选工作。

### 5.2 NVIDIA NIM

`NvidiaCatalogSource` 使用随包发布的、经过验证的免费 tool-calling 模型清单。清单包含模型 ID、上下文窗口、Tier 与能力声明，并在发布前通过维护脚本更新。运行时仍与 `ctx.llm.listModels('nvidia')` 交叉验证，避免选择当前 `llm-pi-ai` 目录无法执行的模型。

### 5.3 Tier 数据

首版 Tier 数据从 MIT 许可的 free-router 排名数据派生，仓库保留来源、许可和生成说明。运行时代码不从 free-router 仓库联网拉取数据。无法匹配排名的模型使用保守的最低未知等级，除非用户通过配置显式允许。

## 6. 请求数据流

### 6.1 启动

1. 加载版本化缓存和 NVIDIA 静态目录。
2. 注册 Settings、DSH 事件监听器与取消控制器。
3. 异步刷新 OpenRouter 目录。
4. 从 `ctx.llm.listProviders()` 与 `listModels()` 建立当前可执行候选快照。
5. 对每个 Provider 中 Tier 最高的少量候选执行初始健康探测。
6. 监听 `llm/adapters-updated`，在 Models 或凭据配置变化后重算候选池并解除相应 Provider 的配置故障隔离。

启动过程不等待全量探测完成。冷启动没有实时指标时，先使用 Tier 最高且未冷却的候选。

### 6.2 请求选择

插件以 `prepend` 方式注册 `agent/request` 监听器：

1. 调用 `next()` 读取下游提出的原始 `LlmCallConfig`。
2. 若插件禁用、没有有效候选或该调用不属于主 Agent，则返回原配置。
3. 读取当前候选不可变快照。
4. 排除禁用、冷却以及本次 `turn/step` 已尝试过的候选。
5. 按可用性、Tier、平均延迟、成功率和稳定模型 ID 排序。
6. 返回真实 `provider/model`。
7. 默认移除跨模型不安全的 `reasoningEffort`，使用目标模型自身默认值。
8. 追加非 surface 的 `free-router/selected` 会话事件。

每个 Agent 使用弱引用保存当前 `turn/step` 的尝试状态。进入新的步骤时覆盖旧状态，同一步不会重复选择同一个候选，Agent 释放后状态可被自动回收。

### 6.3 成功观测

插件通过只观测、不改写的 `llm/stream` middleware 记录主 Agent 请求的首分片延迟与终止状态。成功结果更新模型滚动指标并解除连续失败计数。健康探测由调用方直接更新指标，避免与真实流量重复计数。

## 7. 健康探测与排序

### 7.1 探测策略

健康探测通过 `llm-pi-ai` 发出 `maxTokens: 1` 的最小请求，验证与真实请求相同的凭据和协议链路。默认策略为：

- 单次超时 6 秒。
- 全局探测并发 4。
- 每个 Provider 最多保留 8 个活跃候选。
- 活跃候选每 60 秒探测一次。
- 非活跃或连续失败候选逐步退避，最长 10 分钟。
- 真实 Agent 请求同时贡献成功率与延迟数据。

插件不采用每 2 秒探测全部模型的策略，避免消耗免费额度并制造额外限流。

### 7.2 指标

每个模型维护有限窗口内的：

- 探测与真实请求总数。
- 成功数和成功率。
- 成功请求的首分片延迟总和与平均值。
- 最近终止状态。
- 连续失败次数。
- 冷却截止时间。

排序使用稳定比较器：

1. 已确认可用优先于未知，未知优先于当前不可用。
2. Tier 较高者优先。
3. 平均延迟较低者优先。
4. 成功率较高者优先。
5. `provider/model` 字符串作为确定性最终 tie-breaker。

## 8. 故障切换

插件以 `prepend` 方式注册 `agent/request-error`，确保有替代候选时优先做跨模型切换。不同故障采用不同隔离范围：

| 故障 | 处理 |
|---|---|
| `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` | 当前模型进入指数冷却，重试下一候选 |
| `UNKNOWN_MODEL` | 移除模型、触发目录刷新、重试下一候选 |
| `AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`QUOTA` | 隔离整个 Provider，尝试另一 Provider |
| `UNSUPPORTED_OPTION`、上下文溢出、无效请求 | 不盲目切换，委托下游 DSH 错误处理 |

同一 `turn/step` 默认最多尝试 4 个不同模型。有可用替代候选时返回 `{ kind: 'retry' }`；没有替代候选时调用 `next()`，交由 DSH 既有恢复链或最终错误处理。

OpenRouter 和 NVIDIA 的 `llm-pi-ai` profile 推荐配置 `retryPolicy.mode: normal`、`maxRetries: 0`，避免同一过载模型先执行五次 Provider 内重试。插件不强制覆盖用户现有配置。

失败流产生的部分 chunk 由 DSH agent loop 管理，不形成最终 assistant message。切换后的尝试仍从同一份持久历史重建请求。每次切换追加非 surface 的 `free-router/failover` 事件。

## 9. 配置设计

插件使用 `free-router` Settings namespace：

```yaml
free-router:
  enabled: true
  providers:
    openrouter:
      enabled: true
      route: openrouter
    nvidia:
      enabled: true
      route: nvidia
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

Provider 连接与凭据由 `llm-pi-ai` 管理：

```yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      retryPolicy:
        mode: normal
        maxRetries: 0
    nvidia:
      apiKeyEnv: NVIDIA_API_KEY
      retryPolicy:
        mode: normal
        maxRetries: 0
```

`dsh.bundle` 只插入 free-router 插件，不覆盖已有的 `llm-pi-ai` 配置。缺少路由时插件不接管请求，并输出节流且可操作的诊断。用户通过 DSH Models 页面或 `settings.yaml` 配置 Provider 与凭据，修改在下一次请求生效，无需重启。

## 10. 安全与持久化

插件不直接读取、保存或验证 API key 内容。模型请求和健康探测均由 `llm-pi-ai` 经 DSH credentials service 解析凭据。

持久缓存仅包含：

- 最近一次有效的 OpenRouter 目录。
- 模型滚动健康指标。
- Provider/模型冷却截止时间。
- 数据版本和更新时间。

缓存使用版本化结构和原子替换。超过 TTL 的缓存只作为冷启动排序参考，不得把模型标记为实时可用。缓存损坏或版本不兼容时忽略并重建；缺少持久化服务时退化为内存模式。

日志、缓存与会话事件不得包含 API key、Authorization header、prompt、响应正文或密钥片段。

## 11. 可观测性与生命周期

`free-router/selected` 事件包含 turn、step、attempt、provider、model、选择原因和无敏感信息的指标快照。`free-router/failover` 包含失败 code、被隔离范围、下一候选与尝试次数。这两类事件均为非 surface 事件，不进入模型上下文。

目录刷新失败保留最后有效快照并输出节流 warning。所有候选失败时，最终诊断列出已尝试的 provider/model 和稳定错误 code，不包含请求或凭据数据。

插件卸载或 HMR 时取消目录请求、探测、退避计时器与活动迭代器，等待已启动任务收敛后释放监听器，不允许已释放插件继续写指标或触发重试。

## 12. 工程结构

```text
dsh-free-router/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── catalog/
│   │   ├── source.ts
│   │   ├── openrouter.ts
│   │   └── nvidia.ts
│   ├── eligibility/policy.ts
│   ├── ranking/
│   │   ├── policy.ts
│   │   └── store.ts
│   ├── health/
│   │   ├── monitor.ts
│   │   └── metrics.ts
│   ├── runtime/
│   │   ├── router.ts
│   │   └── attempt-state.ts
│   └── persistence/cache.ts
├── data/
│   ├── nvidia-models.json
│   ├── model-rankings.json
│   └── ATTRIBUTION.md
├── tests/
├── cordis.patch.yml
├── package.json
└── README.md
```

包 manifest 声明 `dsh.bundle.patch`，并对 DSH/Cordis 使用与目标 DSH 版本兼容的 peer dependency。由于 DSH 仍处于 developer preview，首版发布固定一组已验证的 DSH minor 版本，并通过 CI 兼容矩阵再扩大范围。

## 13. 测试策略

- **单元测试**：免费过滤、tools 过滤、Tier 排序、滚动指标、冷却、配置校验。
- **属性测试**：候选输入顺序不改变排序结果；同一步不会重复选择同一模型。
- **目录契约测试**：将 OpenRouter/NVIDIA fixture 转换为统一候选结构，并覆盖字段缺失与目录漂移。
- **DSH 集成测试**：使用真实 agent loop 与 mock adapter 验证 request header、真实 provider/model、部分流失败、跨模型切换、候选耗尽和取消。
- **安全测试**：断言日志、缓存与会话事件不包含测试密钥、Authorization 或请求正文。
- **可选 E2E**：存在对应环境变量时调用 OpenRouter/NVIDIA；默认 CI 不依赖外部密钥。
- **发布检查**：typecheck、lint、测试、构建、package exports 检查，以及从本地目录安装到 DSH profile 的 smoke test。

测试通过注入时钟、随机数、fetch、目录源和 LLM 探测器保持确定性，不使用真实 sleep 验证退避。

## 14. 首版验收标准

1. 插件可通过 DSH plugin 命令安装，无需修改 DeepSeek Harness 源码。
2. 路由池只包含免费且确认支持 tool calling 的模型。
3. 每次成功响应在持久历史中记录真实 provider/model。
4. 429、5xx、超时、传输失败和空响应可切换到未尝试候选。
5. 单步骤切换有明确上限，取消能立即终止探测和请求恢复。
6. Settings/Models 修改无需重启即可影响后续请求。
7. OpenRouter 目录不可用时可使用有效缓存或 NVIDIA 静态目录。
8. 缓存、日志和事件不包含密钥、prompt 或响应正文。
9. 新增第三种 `CatalogSource` 不需要修改 EligibilityPolicy、HealthMonitor 或 RoutingPolicy。

## 15. 后续扩展：任意 OpenAI-compatible Provider

后续增加 `OpenAICompatibleCatalogSource`，通过配置描述 Provider 路由、模型发现端点和资格规则。由于通用 OpenAI-compatible `/models` 没有统一价格或 tool-calling 元数据，首版之后的扩展必须支持显式能力声明：

```yaml
free-router:
  providers:
    my-provider:
      enabled: true
      route: my-provider
      catalog:
        type: openai-compatible
        modelsEndpoint: /models
      eligibility:
        freePolicy: explicit
        toolCalling: true
        includeModels:
          - coder-model-a
          - coder-model-b
```

`llm-pi-ai` 继续负责 `baseURL`、`api`、`apiKeyEnv`、headers、compat 和真实模型请求。路由器只消费统一候选结构，因此不会感知具体 OpenAI-compatible wire protocol。

## 16. 参考资料

- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- free-router：<https://github.com/bytonylee/free-router>
