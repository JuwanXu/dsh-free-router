# DSH Free Router 动态免费模型登记设计

日期：2026-09-15  
状态：待用户审阅

## 背景

`dsh-free-router` 已能从 OpenRouter 目录发现符合资格的免费模型，但现有实现会先调用 `ctx.llm.listModels(route)`，再将发现结果与该列表求交集。`@deepseek-ai/dsh-llm-pi-ai` 的 `providers.<route>.models` 显式配置又会替换其内置目录。因此，当用户只在 `settings.yaml` 中配置两个模型时，DSH 的选择器和 Free Router 都只能看见这两个模型。

目标是在**现有的 `dsh-free-router` 插件**中，自动把目录中合格的免费模型登记为 DSH 可选模型；用户能在 DSH 模型下拉列表选择它们、将其设为默认模型，同时仍由 Free Router 完成按健康度的自动切换。

## 已确认的决策

- 采用独立托管路由，不改写用户原有的 `openrouter` 路由或其手工模型列表。
- 自动登记模型需要显示在 DSH 模型选择界面，并可设置为默认模型。
- 首期动态目录源为 OpenRouter；NVIDIA 继续使用现有静态目录和现有路由。
- 后续需支持任意 OpenAI-compatible Provider，但不能假定通用 `/models` 响应包含价格或工具调用能力。
- 只登记同时满足现有资格策略的模型：免费、支持工具调用、满足上下文窗口、Tier、包含/排除名单约束。
- 目录或设置写入失败时保留最后一次成功的登记和候选快照，不删除仍可用的回退路径。

## 方案选择

### 未采用：更新 `openrouter.models`

每次刷新直接覆盖用户已有的 `llm-pi-ai.providers.openrouter.models`。实现短，但刷新会与用户的手工模型、其他插件或设置界面产生写入竞争，也无法可靠判断哪些条目属于插件。该方案不采用。

### 采用：独立托管路由

Free Router 创建并维护一个专用的 `llm-pi-ai` 路由，默认名为 `free-router-openrouter`。该路由复用用户原有 `openrouter` 路由的连接参数与凭据引用，但它的 `models` 只包含插件登记的免费模型。

```text
用户的 openrouter 路由（保持原样）
           │  复制非敏感连接配置：apiKeyEnv、baseURL、api、headers、retryPolicy…
           ▼
free-router-openrouter（插件托管）
           │  models = 当前发现并通过资格筛选的免费模型
           ▼
DSH Models 选择器 / 默认模型 / Free Router 候选池
```

运行时候选的真实 `provider` 为 `free-router-openrouter`，不会引入虚拟 LLM adapter。请求、错误、用量、会话事件仍记录实际执行的 provider/model 组合。

### 未采用：虚拟 Provider adapter

将所有模型伪装为 `free-router/auto` 会破坏真实来源归因，并使重放、错误处理与健康指标跨 adapter 委托化。继续复用官方 `llm-pi-ai` adapter。

## 配置契约

在 `free-router` 设置中新增 `registration`。保持现有 `providers.openrouter.route` 表示用户原始连接路由；托管目标由 `registration.openrouter` 单独描述。

```yaml
llm-pi-ai:
  providers:
    # 用户维护；插件绝不修改这一项。
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      baseURL: https://openrouter.ai/api/v1
      api: openai-completions
      models:
        - id: my-manual-model

free-router:
  providers:
    openrouter:
      enabled: true
      route: openrouter             # 动态登记的连接来源
  registration:
    openrouter:
      enabled: true
      route: free-router-openrouter # DSH 中出现的托管模型路由
      displayName: Free Router · OpenRouter
```

新增设置字段：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `registration.openrouter.enabled` | `false` | 显式启用，保持已有安装的兼容性。|
| `registration.openrouter.route` | `free-router-openrouter` | 托管路由 ID，必须非空且不能与来源路由相同。|
| `registration.openrouter.displayName` | `Free Router · OpenRouter` | DSH 设置页/模型选择器的 Provider 展示名。|

启用后，插件从 `llm-pi-ai.providers[providers.openrouter.route]` 读取已解析的连接描述；只复制凭据**引用**（如 `apiKeyEnv`），绝不读取或持久化 API Key 本身。它会在 `llm-pi-ai.providers[registration.openrouter.route]` 写入生成的配置，并设置 `displayName` 与模型列表。

如果来源路由不存在、目标路由已由非插件配置占用、或两者同名，插件拒绝接管、保留现有候选，并给出节流且可操作的诊断。不会覆盖不匹配的目标路由。

## 登记与刷新流程

### 启动和配置变更

1. 读取 Free Router 与 `llm-pi-ai` 已注册的设置值。
2. 读取 OpenRouter 目录，使用现有严格规则过滤资格。
3. 将合格模型转换为 `PiAiModelProfile`：`id`、目录展示名、上下文窗口；未提供的能力使用托管路由的安全默认值。
4. 基于来源路由构造托管路由的非模型配置，并通过 `settings.mutate('llm-pi-ai', …)` 原子写入目标路由。
5. 等待 `llm/adapters-updated`，然后从 `ctx.llm.listModels(targetRoute)` 读取实际可执行模型。
6. 仅将该实际列表与本次合格目录求交集，生成运行时候选；候选的 `provider` 改为目标路由。
7. 保存目录、登记清单和健康指标缓存，唤醒健康探测与等待中的选路。

目录刷新、相关设置更新、`UNKNOWN_MODEL` 或适配器重建均复用该流程。模型已不再满足免费/工具调用资格时，会从托管 `models` 列表和 Free Router 候选中移除；正在进行的请求保留其调用时的 adapter 快照，不会被中途切换。

登记写入自身会触发 `llm/adapters-updated`，因此刷新协调器必须以单飞（single-flight）队列和配置指纹去重：同一来源/目标/模型集合的投影不写入设置；由本次登记写入引发的 adapter 事件只做一次可执行性复核，不再次发起目录登记。这样既能响应外部配置更新，又不会形成“写设置 → adapter 更新 → 再写设置”的循环。

### 失败处理

- **目录请求失败**：不写空列表；保留最后成功的托管模型及候选缓存。
- **设置写入失败或被验证拒绝**：不改候选快照；记录稳定错误码，不记录请求、响应或密钥。
- **适配器未出现或 `listModels` 失败**：不将未验证模型投给路由；保留上一批已验证候选。
- **托管路由冲突**：停用该注册器，不触碰冲突路由；用户可修改 `registration.openrouter.route` 后重试。
- **用户关闭注册器**：停止刷新和向候选池新增托管模型；默认不自动删除目标路由，避免删除用户可能已在使用的 DSH 配置。后续可提供显式清理命令/设置。

## 所有权与并发写入

设置服务会串行化 namespace 写入，但不能自动识别不同写入者的业务所有权。因此实现应遵守：

1. 只使用配置指定的专属目标路由，默认带 `free-router-` 前缀。
2. 首次写入前要求目标路由不存在；若已存在，必须与插件生成的静态连接配置完全一致且能在本地登记缓存中证明为本插件此前创建，否则拒绝写入。
3. 后续刷新仅改变目标路由的 `models`；来源路由和其他 `llm-pi-ai` provider 一律不改。
4. 每次写入前重新读取 `llm-pi-ai` 设置；使用 path 级 `mutate`，不使用整个 namespace 的 `replace`，以免删除其他 provider 或凭据引用。
5. 在插件缓存中持久化托管路由 ID、来源路由 ID、静态配置摘要和最后成功模型 ID 集合。缓存不可用时采用保守策略：不接管一个已存在的目标路由。

## 模型元数据与安全默认值

OpenRouter 目录可提供模型 ID、名称、上下文窗口、价格及支持参数，但不总能提供完整的 pi-ai 模型能力。登记器仅使用经过验证的目录字段，并在托管路由上设置已有 `llm-pi-ai` 安全默认值：文本输入、默认上下文窗口和默认最大输出 token。它不从模型名推断付费状态或工具调用能力。

目录中仅有 `/models` 但没有可信价格/能力元数据的通用 OpenAI-compatible Provider，不能自动判断“免费”。后续扩展提供两种显式策略：

- Provider 专用目录适配器，输出与 OpenRouter 相同的价格和能力事实；或
- 配置式 `freeModelIds` 清单，由用户对免费资格负责。

两种策略都复用托管路由登记器，无需改变健康、排序或故障切换逻辑。

## 代码边界

- `src/config.ts`：新增注册器配置、默认值和来源/目标路由校验。
- `src/registration/`：新增托管路由规划、配置投影、所有权校验与 settings 写入模块；该模块不调用 LLM。
- `src/catalog/registry.ts`：调整目录刷新顺序，使 OpenRouter 原始目录可先用于登记，再与目标 adapter 的实际模型列表交叉验证。
- `src/index.ts`：协调刷新事务、监听 `llm/adapters-updated` 与 `settings/updated`，把运行时候选映射到托管路由。
- `src/persistence/cache.ts`：升级缓存版本，加入登记器所有权状态和最后成功的登记模型；保留向旧缓存的安全降级读取。
- `src/providers.ts`：声明每个目录源是否支持动态登记；NVIDIA 首期保持不变。
- `docs/` 与根 `README.md`：增加启用、冲突、关闭和手动默认模型设置说明。

领域层不得依赖 Cordis/DSH；settings 访问仅位于登记协调器和插件入口。

## 测试与验收

1. 配置测试：注册器默认关闭；启用时拒绝空路由、来源与目标同名、非法展示名。
2. 登记器单元测试：目录模型投影为正确的 `PiAiModelProfile`；只复制非敏感连接配置；不读取 API Key 值。
3. 所有权测试：目标不存在时创建；冲突目标不覆盖；缓存身份不匹配时不接管；刷新只更新 `models` 路径。
4. 生命周期测试：启动后完成“发现 → 登记 → adapter 更新 → 可执行候选”；目录失败、写入失败、adapter 不可用均保留上一成功快照。
5. 资格测试：付费、无工具调用、不满足上下文、被排除或低于 Tier 的模型不会出现在 DSH 托管路由。
6. 集成测试：`ctx.llm.listModels('free-router-openrouter')` 返回动态模型；模型可作为 Agent 默认模型；首个模型限流后仍按现有逻辑自动切换下一模型。
7. 回归：现有 NVIDIA 路由、关闭注册器的旧配置、缓存迁移、健康探测、限流与 camel/continue 协作全部通过。

## 非目标

- 不直接调用 `llm-pi-ai` 内部/私有 API，也不修改 DSH 核心。
- 不将 API Key 写入 Free Router 配置、缓存、日志或会话事件。
- 不自动把所有 OpenRouter 模型登记为免费模型。
- 不在关闭注册器时擅自删除用户设置。
- 不在首期支持没有可验证免费资格来源的通用 OpenAI-compatible Provider。
