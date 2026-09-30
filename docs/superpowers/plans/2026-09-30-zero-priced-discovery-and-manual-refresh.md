# Zero-priced Discovery and Manual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dsh-free-router` 默认发现不带 `:free` 后缀的 OpenRouter 零价格工具模型，并通过会话命令完成、报告和查询一次完整的动态模型刷新。

**Architecture:** OpenRouter 目录源以 `catalog.zeroPricedWithoutSuffix` 为输入，保留目录事实校验和既有 eligibility 过滤顺序。入口的单飞刷新协调器生成结构化 `RefreshReport`，命令层只解析 `/free-router refresh|status` 并异步等待目标刷新轮次，保证不会绕过托管路由的 reconcile、可执行性确认、缓存写入或 `runtime.wake()`。

**Tech Stack:** TypeScript 5.8、Vitest 3、Cordis 4、DSH Settings、`@deepseek-ai/dsh-llm-pi-ai`、Node.js 22.19+。

**Spec:** `docs/superpowers/specs/2026-09-30-zero-priced-discovery-and-manual-refresh-design.md`

## Global Constraints

- 开发基线为 `aabe8a0`，交付版本为 `0.1.3`，但不执行 `npm publish`。
- 保留真实的 `provider/model`，不注册虚拟 LLM adapter，也不修改 DSH 核心。
- 默认 `catalog.zeroPricedWithoutSuffix: true`；关闭后严格恢复 `:free` 后缀目录行为。
- 仅接受 prompt/completion 均为零、支持 `tools`、上下文窗口为正安全整数的 OpenRouter 条目；始终排除 `openrouter/free`。
- `routing.includeModels`、`routing.excludeModels`、最小上下文窗口和 Tier 仍在目录发现后生效；默认 `minimumTier` 改为 `?`。
- 目录、Settings 或 adapter 失败时保留上一批成功快照；不得用空结果覆盖托管模型，且不得覆盖无所有权声明的目标路由。
- `scheduleRefresh()` 保持所有自动触发点与现有 generation/single-flight/queued 语义；手动刷新不得并行写设置。
- 报告、命令和日志不得输出 API key、Authorization header、请求或响应内容，只能包含安全错误码和公开模型 ID。
- 命令服务是可选注入；不存在或注册失败时插件仍加载。命令 handler 可返回 Promise，已由桌面 Profile 的 `dsh-continue` 实装契约验证。
- 不放宽 peerDependencies；桌面 DSH 0.2.0-rc.2 安装时由作者执行 `allow-version` 精确豁免。

## Review Focus

- 价格字符串 `"0.0"`、数字 `0` 与异常字符串必须按零价格/非零价格正确区分；测试归入任务 1。
- `catalog.zeroPricedWithoutSuffix: false` 时，无后缀零价格模型绝不能泄漏进托管路由；测试归入任务 1 与任务 3。
- `openrouter/free` 即使价格、工具和上下文均合格也必须被固定排除；测试归入任务 1。
- 自动刷新和手动刷新交叠时，命令应等待其归属的最终一轮，且对同一次路由变更至多写入一次；测试归入任务 3。
- 托管来源缺失、目标冲突、目录失败或写回失败时，`status`/`refresh` 应给出安全原因并保留上一成功候选；测试归入任务 3。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 声明、默认化并严格校验 `catalog` 段和新的 Tier 默认值。 |
| `src/catalog/openrouter.ts` | 依据显式目录策略从 OpenRouter 条目构造候选并排除元路由。 |
| `src/providers.ts` | 将当前目录策略传递给每次刷新新建的目录源。 |
| `src/refresh-report.ts` | 定义公开、安全的 `RefreshReport`、登记状态和差异计算工具。 |
| `src/commands.ts` | 注册可选异步命令，解析输入并渲染报告。 |
| `src/index.ts` | 将刷新状态机接入报告、等待者、托管路由结果和命令服务。 |
| `tests/openrouter-catalog.spec.ts`、`tests/config.spec.ts` | 目录资格与配置契约。 |
| `tests/free-router-commands.spec.ts` | 命令解析、异步回报和纯文案渲染。 |
| `tests/dynamic-registration-integration.spec.ts`、`tests/lifecycle.spec.ts` | 手动刷新、排队、托管写回与自动触发回归。 |
| `README.md`、`docs/README.zh-CN.md`、`docs/release-checklist.md`、`package.json` | 用户配置、隐私说明、桌面安装/发布交接和版本。 |

### Task 1: 目录资格和配置契约

**Files:**
- Modify: `src/config.ts`
- Modify: `src/catalog/openrouter.ts`
- Modify: `src/providers.ts`
- Modify: `tests/config.spec.ts`
- Modify: `tests/openrouter-catalog.spec.ts`

**Interfaces:**
- Produces `CatalogConfig { zeroPricedWithoutSuffix: boolean }` and `RouterConfig.catalog`.
- Produces `providerCatalogSources(catalog: CatalogConfig): CatalogSource[]`.
- Produces `OpenRouterCatalogSource` configured with `zeroPricedWithoutSuffix`.

- [ ] **Step 1: 写目录和配置失败测试**

在 `tests/openrouter-catalog.spec.ts` 添加一个目录夹具，包含 `org/suffixed:free`、`stealth/space-bunny-alpha`、`openrouter/free`、付费、缺失 pricing、无 tools、零/负数/非安全整数 context 条目。断言默认开关只保留前两者；关闭开关只保留 `org/suffixed:free`。

在 `tests/config.spec.ts` 增加断言：空配置得到 `{ catalog: { zeroPricedWithoutSuffix: true }, routing: { minimumTier: '?' } }`；`false` 可解析；`catalog` 非对象、字段非布尔值和未知顶层键抛出 `TypeError`。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/openrouter-catalog.spec.ts tests/config.spec.ts`

Expected: FAIL，当前无 `catalog` 配置、默认 Tier 仍为 `B`，且无后缀模型被丢弃。

- [ ] **Step 3: 实现配置和目录策略**

在 `src/config.ts` 定义并默认化 `CatalogConfig`，将 `catalog` 加入 Schemastery `Config`、`RouterConfig`、`defaultConfig`、`unknownTopLevel` 和 `parseConfig()`；仅接受布尔 `zeroPricedWithoutSuffix`。

将默认 `routing.minimumTier` 改为 `?`，但不改变 `eligible()` 的比较规则。

在 `src/catalog/openrouter.ts` 让 `modelFrom()` 接受策略：先检查零 prompt/completion、tools 和安全正整数 context；ID 为 `openrouter/free` 时始终返回 `undefined`；带 `:free` 的 ID 保留；不带后缀时仅在策略开关为真时保留。

在 `src/providers.ts` 让 `providerCatalogSources(catalog)` 为每次刷新按当前配置构造 `OpenRouterCatalogSource`，避免 Settings 变更后继续使用启动时的开关值。

- [ ] **Step 4: 验证单元测试和类型检查**

Run: `pnpm exec vitest run tests/openrouter-catalog.spec.ts tests/config.spec.ts && pnpm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交目录资格改动**

```bash
git add src/config.ts src/catalog/openrouter.ts src/providers.ts tests/config.spec.ts tests/openrouter-catalog.spec.ts
git commit -m "feat: discover zero-priced OpenRouter models"
```

### Task 2: 刷新报告与命令边界

**Files:**
- Create: `src/refresh-report.ts`
- Create: `src/commands.ts`
- Create: `tests/free-router-commands.spec.ts`

**Interfaces:**
- Produces `RefreshReport` with public counts, timestamps, registration kind, model deltas and safe failures.
- Produces `FreeRouterCommandView { refresh(): Promise<RefreshReport>; status(): RefreshReport | undefined }`.
- Produces `registerFreeRouterCommands(registry: FreeRouterCommandRegistry, view: FreeRouterCommandView): void`.

- [ ] **Step 1: 写命令失败测试**

在 `tests/free-router-commands.spec.ts` 用假 `FreeRouterCommandRegistry` 捕获命令定义，并用受控 Promise 的 `view.refresh()` 验证 handler 为异步、在 Promise 完成前不返回、完成后文本包含发现数、资格数、登记 `update`、新增/移除模型和安全失败码。

增加 `status` 返回最后报告、空状态给出尚无刷新记录、未知子命令返回 `usage: /free-router refresh | status` 的断言；确保报告中的敏感样例字段不会被格式化。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/free-router-commands.spec.ts`

Expected: FAIL，`src/commands.ts` 与 `src/refresh-report.ts` 不存在。

- [ ] **Step 3: 实现纯报告和命令模块**

在 `src/refresh-report.ts` 定义 `RegistrationRefreshKind`、`RefreshFailure`、`RefreshReport` 和根据前后 `modelIds` 计算稳定、排序差异的纯函数。错误仅通过现有 `safeErrorCode()` 等价的 allowlist 进入报告。

在 `src/commands.ts` 参照本机 `dsh-continue/src/commands.ts` 定义最小 registry/invocation 结构；注册单个名为 `free-router` 的异步命令。`refresh` 调用并等待 view，`status` 只读取 view；所有异常转为 `{ kind: 'error', text }`，且不回显原始异常文本。

- [ ] **Step 4: 验证命令单元测试**

Run: `pnpm exec vitest run tests/free-router-commands.spec.ts && pnpm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交报告和命令模块**

```bash
git add src/refresh-report.ts src/commands.ts tests/free-router-commands.spec.ts
git commit -m "feat: add free-router refresh commands"
```

### Task 3: 将报告和手动刷新接入单飞生命周期

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/lifecycle.spec.ts`
- Modify: `tests/dynamic-registration-integration.spec.ts`

**Interfaces:**
- Consumes: `providerCatalogSources(current().catalog)`, `RefreshReport`, `registerFreeRouterCommands()`.
- Produces: `scheduleRefresh(intent?): Promise<RefreshReport>`，每个调用等待其归属的最终刷新轮次。
- Produces: 状态视图，暴露最后成功或失败报告而不暴露内部状态/密钥。

- [ ] **Step 1: 写生命周期与登记失败测试**

在 `tests/dynamic-registration-integration.spec.ts` 的现有 `startPlugin()` 测试支架中注入可选 `commands` 服务，并在目录夹具加入 `stealth/space-bunny-alpha` 和 `openrouter/free`。

新增断言：默认配置、`minimumTier: '?'` 下托管路由的 `models` 包含 `stealth/space-bunny-alpha` 而不包含 `openrouter/free`；关闭 `zeroPricedWithoutSuffix` 后的手动刷新从托管清单移除前者并报告 `update`/移除 ID。

在 `tests/lifecycle.spec.ts` 或同一集成文件用延迟目录加载触发自动刷新后立即调用 `/free-router refresh`；断言只发生顺序化的预期写回、命令等待最终回读后的报告、`runtime.wake()` 后候选数与报告一致。另覆盖目标路由冲突、来源路由缺失和目录失败的 `conflict`/`skipped` 与失败码报告，并确认已有候选未清空。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/lifecycle.spec.ts tests/dynamic-registration-integration.spec.ts`

Expected: FAIL，手动命令未注册、刷新没有报告、零价格无后缀模型未写入托管清单。

- [ ] **Step 3: 实现刷新协调器报告和等待者**

在 `src/index.ts` 中移除固定的 `CatalogRegistry(providerCatalogSources())` 实例；每个完整发现阶段按 `current().catalog` 创建目录源，保留同一个外部健康、缓存和候选状态。

将 `refresh(generation)` 改为在所有出口产生 `RefreshReport`：发现后记录 discovered/eligible 数量；登记 reconcile 映射为 `create`、`update`、`unchanged`、`conflict` 或 `skipped`；只有完成 adapter 回读、候选更新、`persistCache()` 调度和 `runtime.wake()` 后报告才算完成。因登记写入产生的 adapter 事件须被视为同一刷新事务的下一阶段，不能让手动命令在写设置后过早完成。

用 generation 关联的 waiter 队列替换 `triggerRefresh: () => void`。已有自动调用可忽略返回 Promise；命令调用等待自己触发或合并后的最终报告。处置时 resolve/reject 等待者为安全的已取消报告，避免悬挂 Promise。保持 `refreshTasks`、`refreshQueued` 和所有既有自动触发点。

通过 `ctx.inject(['commands'], ...)` 注册命令；若命令注册同步抛出，记录无敏感告警并继续加载。

- [ ] **Step 4: 验证生命周期、集成和回归测试**

Run: `pnpm exec vitest run tests/lifecycle.spec.ts tests/dynamic-registration-integration.spec.ts tests/dsh-integration.spec.ts`

Expected: PASS。

- [ ] **Step 5: 提交协调器改动**

```bash
git add src/index.ts tests/lifecycle.spec.ts tests/dynamic-registration-integration.spec.ts
git commit -m "feat: report and trigger manual catalog refresh"
```

### Task 4: 版本、双语文档和可安装产物

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/README.zh-CN.md`
- Modify: `docs/release-checklist.md`
- Modify: `tests/package.spec.ts`
- Modify: `tests/release-files.spec.ts`

**Interfaces:**
- Produces npm package version `0.1.3` and documentation matching the actual configuration/command contracts.

- [ ] **Step 1: 写版本和发布内容失败测试**

在已有 package/release 文件测试中断言版本为 `0.1.3`，`dist` 中包含新增命令模块，且 package files 继续包含两个 README。若现有测试由 `package.json` 自动读取版本，则添加一个显式 release checklist 文案检查而非脆弱的整文件快照。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/package.spec.ts tests/release-files.spec.ts`

Expected: FAIL，版本仍为 `0.1.2`，文档/构建内容未反映新命令。

- [ ] **Step 3: 更新版本和文档**

将 `package.json` 升至 `0.1.3`。两个 README 都必须展示 `catalog.zeroPricedWithoutSuffix: true`、默认 `minimumTier: '?'`、`openrouter/free` 排除建议、`/free-router refresh|status` 的输出语义和隐私提示：stealth/cloaked 零价格模型可能被提供方记录或用于训练，关闭开关可恢复后缀规则。

说明 Desktop 0.2.0-rc.2 的安装/验证命令，并将发布清单限定为作者执行：`pnpm run check`、`pnpm pack`、安装 tarball、`allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk`、桌面 App 验证 `/free-router refresh`，最后才由作者执行 `npm publish`。

- [ ] **Step 4: 生成并检查可安装 tarball**

Run: `pnpm run check && pnpm run test:integration && pnpm run test:smoke && pnpm pack --pack-destination /tmp/dsh-free-router-0.1.3-pack`

Expected: 全部 PASS，生成 `dsh-free-router-0.1.3.tgz`；不执行 publish。

- [ ] **Step 5: 提交发布准备**

```bash
git add package.json README.md docs/README.zh-CN.md docs/release-checklist.md tests/package.spec.ts tests/release-files.spec.ts
git commit -m "chore: prepare 0.1.3 release"
```

### Task 5: 最终验证和交接

**Files:**
- Verify only: 全仓库与 `/tmp/dsh-free-router-0.1.3-pack/dsh-free-router-0.1.3.tgz`

- [ ] **Step 1: 执行完整检查**

Run: `pnpm run check && pnpm run test:integration && pnpm run test:smoke`

Expected: PASS，无失败或未处理 Promise 警告。

- [ ] **Step 2: 在隔离临时 Profile 安装 tarball 并验证命令可注册**

复制桌面 Profile 到临时 Profile，保留 `compatibility.json` 与 `node_modules` 链接；使用桌面版 CLI 安装 `/tmp/dsh-free-router-0.1.3-pack/dsh-free-router-0.1.3.tgz`，执行：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile <temporary-profile> allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk
"$DSH" --profile <temporary-profile> --dump-config
```

Expected: bundle/config 可解析，`free-router` 的 `catalog` 配置和 `commands` 注入不影响其他插件。若无法进行真实 API 请求，记录该限制，不伪称端到端请求成功。

- [ ] **Step 3: 最终提交和交接说明**

```bash
git status --short
git log --oneline aabe8a0..HEAD
```

在交接中列出改动文件、全部测试输出、tarball 绝对路径、桌面安装/验证命令和作者专用的发布命令；明确未执行 `npm publish`。

## 自检结论

- Spec 覆盖：目录发现、可配置回退、元路由排除、Tier 默认、异步命令、单飞并发、托管登记、缓存/唤醒、双语隐私说明、版本和作者发布交接均分别由任务 1–5 覆盖。
- 类型一致性：`CatalogConfig` 在任务 1 定义后供任务 3 使用；`RefreshReport` 与 `FreeRouterCommandView` 在任务 2 定义后由任务 3 提供。
- Review Focus 的五项均有明确归属测试。
- 计划保持在现有模块边界内，不额外创建 Provider、凭据或 UI 子系统。
