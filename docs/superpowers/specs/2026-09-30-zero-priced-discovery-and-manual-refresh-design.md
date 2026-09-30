# DSH Free Router：零价格模型发现与手动刷新设计

日期：2026-09-30  
状态：已确认，待实施

## 目标与边界

本次在 `dsh-free-router` 的动态 OpenRouter 登记能力上扩展两项功能：

1. 将价格为零、支持工具调用且上下文窗口有效的 OpenRouter 模型纳入目录发现，即使模型 ID 不以 `:free` 结尾。
2. 提供 `/free-router refresh` 与 `/free-router status`，让用户在 DSH 会话内观察并手动完成一次完整刷新。

实现从 `aabe8a0`（`dsh-free-router@0.1.2`）开始，发布版本为 `0.1.3`。本次不修改 DSH 核心、不注册虚拟 Provider、不发布 npm 包，也不修改其他 Profile 或其他 Provider。

## 已确认的产品决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 免费资格 | `prompt === 0 && completion === 0`，仍要求 `tools` 和合法正整数 `context_length` | 价格是目录可验证的事实；`stealth/space-bunny-alpha` 无 `:free` 后缀但符合免费条件。|
| 兼容开关 | `catalog.zeroPricedWithoutSuffix: true` | 默认纳入零价格无后缀模型；设为 `false` 恢复 0.1.2 的 `:free` 后缀规则。|
| 元路由 | 固定排除 `openrouter/free` | 它是 OpenRouter 的路由器而非稳定的普通模型，不能作为 Free Router 的候选。用户仍可使用 `routing.excludeModels` 排除其他不希望探测的模型。|
| Tier 默认值 | `routing.minimumTier` 从 `B` 改为 `?` | 当前排名文件只覆盖极少数模型；`B` 会把大多数真实可用的免费模型全部过滤掉。`?` 使默认配置可用，用户仍可显式收紧到 `B` 等等级。|
| 命令完成形态 | 异步 handler 等待本次刷新完成 | 已核对桌面 Profile 中的 `dsh-continue` 命令契约，handler 返回 `Promise<{ kind, text }>`；可在同一回复中提供完整结果。|
| 兼容性声明 | 不在本次放宽 peerDependencies | 保持功能改动与兼容策略分离；桌面版安装 `0.1.3` 时继续使用精确 `allow-version` 豁免。|

## 配置契约

新增顶层 `catalog` 段，并同时进入 Schemastery `Config`、`RouterConfig`、`defaultConfig` 与严格的 `parseConfig()`：

```yaml
free-router:
  catalog:
    zeroPricedWithoutSuffix: true
  routing:
    minimumTier: '?'
    excludeModels:
      - openrouter/free # 可选；该元路由已由目录源固定排除
```

`catalog` 以外的未知顶层键仍报错；`catalog.zeroPricedWithoutSuffix` 必须为布尔值。`includeModels`、`excludeModels`、最小上下文窗口与 Tier 不改变其顺序：模型先通过目录事实校验，再由既有 eligibility 规则过滤。

## 目录发现

`OpenRouterCatalogSource` 将接收目录策略，而非在 `modelFrom()` 中硬编码 `:free`：

1. 解析合法 ID、价格、工具调用和上下文窗口。
2. 始终要求 prompt 与 completion 均为零价格。
3. 若 ID 以 `:free` 结尾，接受。
4. 若 ID 不带后缀，仅在 `zeroPricedWithoutSuffix` 为真时接受。
5. 无论开关如何，排除 `openrouter/free`。

目录失败时，`CatalogRegistry` 的按来源快照保留语义保持不变。新发现的模型继续经过托管路由规划、实际 adapter 可执行性确认和既有所有权/冲突检查；因此不会扩大写入范围，也不会覆盖非插件托管的目标路由。

## 刷新报告与命令

入口将把当前无返回值的刷新流程转为产生不可变的 `RefreshReport`。报告只包含公开模型 ID、计数、时间、托管路由结果和安全错误代码，不含凭据、请求内容、响应内容或 headers。

```ts
interface RefreshReport {
  requestedAt: number
  completedAt: number
  discoveredCount: number
  eligibleCount: number
  candidateCount: number
  registration: {
    kind: 'create' | 'update' | 'unchanged' | 'conflict' | 'skipped'
    addedModelIds: string[]
    removedModelIds: string[]
    reason?: string
  }
  failures: Array<{ scope: 'catalog' | 'route' | 'registration' | 'refresh'; code: string }>
}
```

`scheduleRefresh()` 仍是唯一的调度入口。它保留现有 generation、single-flight 和 queued 语义，并为每次请求提供一个等待该请求所归属刷新轮次的 Promise。刷新进行中执行 `/free-router refresh` 时不发起并行写入：请求合并到下一轮或当前排队轮次，命令等待该轮 `RefreshReport` 后再返回。

新增 `src/commands.ts`：

- `/free-router refresh`：触发完整链路：目录发现 → eligibility → 托管路由 reconcile/写回 → adapter 可执行性确认 → 缓存落盘 → `runtime.wake()`；返回计数、登记操作、模型增删和失败摘要。
- `/free-router status`：不触发网络请求；返回最后一次报告、上次完成时间、当前候选数、登记/冲突状态及最近失败原因。
- 其他输入返回简短 usage。

命令采用与 `dsh-camel`/`dsh-continue` 相同的可选服务注入：`ctx.inject(['commands'], ...)`。服务缺失或注册失败不得影响路由插件加载。命令层仅解析和格式化；刷新状态机保留在入口协调器，方便单测。

## 自动刷新与失败处理

启动、`llm/adapters-updated`、Free Router 设置变更和未知模型的自动刷新入口不变，均复用相同报告生成逻辑。手动刷新不改变其触发次序。

- 目录请求失败：保留来源上次成功快照；报告 `catalog` 失败。
- 来源路由缺失、写回拒绝、目标冲突：报告相应的 `registration` 状态和安全原因；不覆盖目标配置。
- adapter 目录不可用：保留上一批可执行候选，并报告 `route` 失败。
- 刷新异常：保留现有候选/缓存，报告 `refresh` 失败；命令以错误结果返回，不抛出未处理异常。

## 测试与文档

测试覆盖：

1. OpenRouter 目录：`:free` 的零价格模型、无后缀零价格模型、付费模型、缺价格、无 tools、非法/缺失上下文窗口、关闭开关恢复旧行为、`openrouter/free` 排除。
2. 配置：新段默认值、有效开关、非法值、未知键，以及 `minimumTier: '?'` 的默认契约。
3. 命令：解析、`refresh`/`status` 文案、假报告渲染与错误处理。
4. 生命周期/集成：手动刷新等待排队轮次；完整报告反映 create/update/unchanged/conflict；动态登记的模型清单包含无后缀零价格模型。
5. 回归：目录失败快照、托管所有权冲突、自动刷新触发点、缓存和所有既有测试。

README 英文版与中文文档将更新完整配置、Tier 默认值、手动命令、桌面安装豁免与隐私提示：stealth/cloaked 的零价格模型可能由提供方记录或用于训练；开启默认能力即表示这些模型可进入候选池，用户可通过开关退回 `:free` 规则。

## 验收

- `pnpm run check`、集成与 smoke 测试通过。
- 可联网时，`stealth/space-bunny-alpha` 被发现并在动态登记启用、Tier 允许时进入托管 `models`；关闭开关时不进入。
- 桌面 App 中 `/free-router refresh` 可返回本轮完整结果，`/free-router status` 可显示最近结果；目标路由模型列表与本轮合格目录一致。
- 冲突路由不被覆盖，其他 Profile 与 Provider 不受影响。
- 交付可安装 tarball 或可合并 PR；发布仅提供给作者执行的命令和清单。
