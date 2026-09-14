# dsh-free-router 与 dsh-camel / dsh-continue 联动设计

日期：2026-09-14  
状态：已确认，待实施

## 目标

在 DeepSeek Harness 的同一 profile 中组合安装 `dsh-free-router`、`dsh-camel` 与 `dsh-continue`。免费模型收到 `RATE_LIMIT` 时优先切换到另一个健康的免费模型；只有候选耗尽时才等待限流窗口恢复并重试。

## 职责边界

- `dsh-free-router` 是 `RATE_LIMIT` 的首要恢复者：记录模型失败、隔离/冷却失败模型、选择尚未尝试的候选并立即重试。
- `dsh-camel` 保留请求前主动节流。在 free-router 候选耗尽后，它根据 `Retry-After` 或自身退避策略等待并重试。
- `dsh-continue` 仅处理 `TIMEOUT`、`TRANSPORT`、`SERVER` 等非限流瞬态故障；其 `network.codes` 不包含 `RATE_LIMIT`。
- 内置 DSH 重试仍优先于插件兜底；任何一次失败至多由一个恢复者安排一次重试。

## 数据流

```text
模型请求失败（RATE_LIMIT）
  │
  ├─ free-router 存在健康、未尝试的候选
  │    ├─ 记录失败模型健康状态和 free-router/failover 事件
  │    └─ 返回 retry；下一次 agent/request 使用下一个模型
  │
  └─ free-router 候选耗尽
       ├─ 不返回 retry，保留原始失败链
       └─ dsh-camel 按 Retry-After 或退避追加 llm/retry，等待后重试

非 RATE_LIMIT 的网络故障
  └─ dsh-continue 依既有策略处理
```

两个限流插件继续使用 `agent/request-error` waterfall 的“先下放、后兜底”规则：若下游已经返回 `{ kind: 'retry' }`，外层处理器原样返回。该契约使包的加载顺序不会导致双重等待或双重 retry，不要求三个插件建立硬依赖。

## 配置契约

DSH `web` profile 的 bundle 顺序固定为：基础 bundle、Web bundle、`dsh-free-router`、`dsh-camel`、`dsh-continue`。

- `llm-pi-ai.providers.openrouter.models` 至少配置两个当前可用的、具体的 `:free` 模型；不能使用仅作为聚合标识的 `openrouter/free` 作为 free-router 的唯一候选。
- `agent-default-model` 指向其中一个模型。
- `free-router.enabled: true`，并把 `routing.maxAttemptsPerStep` 设为不少于候选数且最多 32。
- `dsh-camel.defaults.throttle.enabled: true` 用于预防性节流；`retry.enabled: true`、`codes: [RATE_LIMIT]`，且使用 `unlimited`（或用户显式选定的 bounded）模式作为候选耗尽后的兜底。
- `dsh-continue.defaults.network.codes` 维持为不含 `RATE_LIMIT` 的瞬态网络错误集合。

本地集成验证使用 `pnpm pack` 为 `dsh-camel` 和 `dsh-continue` 创建 tarball，再安装到用户的 DSH profile；不得修改其工作区中既有的未提交变更。安装与配置前备份 `~/.dsh/settings.yaml` 和 `~/.dsh/profiles/web`。

## 实现范围

1. 在 `dsh-free-router` 补齐与 dsh-camel 并存时的限流接管测试，覆盖处理器嵌套的两个可能顺序。
2. 如测试发现候选耗尽未能传递给 camel，再以最小方式补充明确的耗尽信号；不得让 free-router 直接等待，也不得引入 dsh-camel 的硬运行时依赖。
3. 为三个插件增加组合安装与推荐配置文档。
4. 只在集成验收 profile 中写入配置；不读取、打印、移动或删除凭据文件。

## 验收标准

1. 单元测试：第一个免费候选返回 `RATE_LIMIT` 后，下一次请求使用第二个候选；没有 `llm/retry` 等待事件。
2. 单元测试：所有候选均已尝试/冷却后，free-router 放弃选路，camel 产生一个标准 `llm/retry` 事件并安排等待。
3. 单元测试：`dsh-continue` 不接管 `RATE_LIMIT`，但仍能处理其配置允许的网络故障。
4. 真实 DSH：三个本地 tarball 均被 profile 加载，配置解析成功。
5. 真实 DSH：通过可控测试桩验证切换与候选耗尽的事件序列；随后向 OpenRouter 的两个实际免费模型发起最小请求，确认至少一个候选可成功返回，并检查 free-router 健康缓存。
6. 所有回归测试、类型检查和构建通过；DSH 服务可正常启动。

## 非目标

- 不做多 API Key 轮换。
- 不将 `RATE_LIMIT` 交给 `dsh-continue`。
- 不修改 DSH 内置的 `dsh-llm-retry`。
- 不删除旧会话、凭据或用户工作区内容。
