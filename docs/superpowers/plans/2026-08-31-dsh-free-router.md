# DSH Free Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可安装的 DSH 插件，在 OpenRouter 与 NVIDIA NIM 的免费 tool-calling 模型间进行请求级健康路由与故障切换。

**Architecture:** 插件只在 DSH `agent/request` 和 `agent/request-error` waterfall 上选择或切换真实路由；模型执行继续交给 `@deepseek-ai/dsh-llm-pi-ai`。领域层负责目录、资格判断、排序、健康与缓存，DSH 适配层负责 Settings、会话事件和生命周期。

**Tech Stack:** Node.js 22、TypeScript ESM、pnpm、Vitest、Cordis、DeepSeek Harness 插件 API、Schemastery。

**Spec:** `docs/superpowers/specs/2026-08-31-dsh-free-router-design.md`

## Global Constraints

- 支持 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 11。
- 不修改 DeepSeek Harness 源码；包必须声明 `dsh.bundle.patch`。
- 不实现自有 LLM adapter；所有真实调用经既有 `llm-pi-ai` 路由完成。
- 任何日志、缓存、会话事件不得出现密钥、Authorization header、prompt 或响应正文。
- 首版仅支持 `openrouter` 和 `nvidia` 路由，候选必须免费且支持 tool calling。
- 只接管主 Agent 请求；不路由 compaction 和 session title 等辅助调用。
- 每个功能先写失败测试、确认失败、再写最小实现；每个任务独立提交。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `package.json` | 发布元数据、DSH bundle manifest、exports、脚本与依赖 |
| `cordis.patch.yml` | 向 profile 插入插件行 |
| `src/types.ts` | 不依赖 DSH 的候选、指标、缓存和选择类型 |
| `src/config.ts` | `free-router` Settings schema 与默认值 |
| `src/eligibility.ts` | 免费、tools、容量、名单资格判断 |
| `src/ranking.ts` | 纯候选排序与选择 |
| `src/health.ts` | 滚动指标、冷却和探测调度规则 |
| `src/catalog/openrouter.ts` | OpenRouter API 目录转换 |
| `src/catalog/nvidia.ts` | NVIDIA 静态目录读取 |
| `src/catalog/registry.ts` | 聚合目录并与 DSH 执行目录交叉验证 |
| `src/persistence/cache.ts` | 版本化无敏感缓存读写 |
| `src/runtime/attempt-state.ts` | 每 Agent/turn/step 的已尝试候选记录 |
| `src/runtime/router.ts` | DSH waterfall、观测、健康探测、故障切换 |
| `src/index.ts` | Cordis 插件入口、Settings 和生命周期接线 |
| `data/nvidia-models.json` | 维护的 NVIDIA 免费 tool-calling 模型目录 |
| `data/model-rankings.json` | 已归因的 Tier 数据 |
| `tests/**/*.spec.ts` | 单元、契约、集成与安全测试 |

## Task 1: 建立可发布插件骨架

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsdown.config.ts`
- Create: `vitest.config.ts`
- Create: `cordis.patch.yml`
- Create: `src/index.ts`
- Create: `tests/package.spec.ts`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**

- Produces: 包名 `dsh-free-router`，入口 export `name`、`inject`、`Config`、`apply`。
- Produces: bundle patch 插入 id `free-router`、name `dsh-free-router` 的 Cordis 行。

- [ ] **Step 1: 写入 package manifest 契约测试**

```ts
import manifest from '../package.json' with { type: 'json' }

it('declares an installable DSH bundle', () => {
  expect(manifest.type).toBe('module')
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.exports['.'].default).toBe('./dist/index.js')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/package.spec.ts`

Expected: FAIL，因为 manifest 尚不存在。

- [ ] **Step 3: 创建最小可构建包**

`package.json` 使用 Node 22 engines、`pnpm@11`，并将 Cordis、`dsh-llm`、`dsh-agent`、`dsh-settings` 作为 peer/dev dependencies。`src/index.ts` 先导出空的 `apply()`；`cordis.patch.yml` 只插入该插件。配置 TypeScript 为 strict ESM，Vitest 跑 `tests/**/*.spec.ts`，构建输出 `dist/index.js` 与声明文件。

- [ ] **Step 4: 运行构建与测试**

Run: `pnpm install && pnpm test && pnpm run typecheck && pnpm run build`

Expected: PASS；构建产物含 `dist/index.js` 和 `dist/index.d.ts`。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsdown.config.ts vitest.config.ts \
  cordis.patch.yml src/index.ts tests/package.spec.ts .gitignore README.md
git commit -m "chore: scaffold dsh free router plugin"
```

## Task 2: 实现候选模型、资格判断与稳定排序

**Files:**

- Create: `src/types.ts`
- Create: `src/eligibility.ts`
- Create: `src/ranking.ts`
- Create: `tests/eligibility.spec.ts`
- Create: `tests/ranking.spec.ts`

**Interfaces:**

- Produces `CandidateModel`：`provider`、`model`、`displayName`、`contextWindow`、`toolCalling`、`free`、`tier`。
- Produces `eligible(candidate, policy): boolean` 和 `rankCandidates(candidates, metrics, now): CandidateModel[]`。

- [ ] **Step 1: 写入资格判断失败测试**

```ts
expect(eligible(candidate({ free: false }), policy())).toBe(false)
expect(eligible(candidate({ toolCalling: false }), policy())).toBe(false)
expect(eligible(candidate({ contextWindow: 8192 }), policy({ minimumContextWindow: 32768 }))).toBe(false)
expect(eligible(candidate({ model: 'keep' }), policy({ includeModels: ['keep'] }))).toBe(true)
```

- [ ] **Step 2: 写入排序失败测试**

```ts
expect(rankCandidates([slowS, fastA, unknownS], metrics, now)
  .map(({ model }) => model))
  .toEqual(['unknownS', 'fastA', 'slowS'])
```

测试还必须覆盖：已确认可用优先未知；同等可用性下 Tier 优先；随后平均延迟、成功率和 `provider/model` 字典序。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/eligibility.spec.ts tests/ranking.spec.ts`

Expected: FAIL，因为领域函数尚未导出。

- [ ] **Step 4: 实现最小纯函数**

定义 `ModelTier`、`HealthSnapshot` 与 `EligibilityPolicy`。不得依赖 DSH、时间器、fetch 或可变全局状态。使用稳定 comparator，未知延迟按 `Infinity` 处理。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/eligibility.spec.ts tests/ranking.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/eligibility.ts src/ranking.ts tests/eligibility.spec.ts tests/ranking.spec.ts
git commit -m "feat: add candidate eligibility and ranking"
```

## Task 3: 实现健康指标、冷却与步骤尝试状态

**Files:**

- Create: `src/health.ts`
- Create: `src/runtime/attempt-state.ts`
- Create: `tests/health.spec.ts`
- Create: `tests/attempt-state.spec.ts`

**Interfaces:**

- Produces `HealthBook.record(candidateKey, outcome, at): void`。
- Produces `HealthBook.snapshot(candidateKey, now): HealthSnapshot`。
- Produces `HealthBook.isCooling(candidateKey, now): boolean`。
- Produces `AttemptState.next(agent, turn, step, candidates): CandidateModel | undefined`。

- [ ] **Step 1: 写入健康失败测试**

```ts
book.record('openrouter/a', { kind: 'failure', code: 'RATE_LIMIT' }, 1_000)
expect(book.isCooling('openrouter/a', 1_001)).toBe(true)
expect(book.snapshot('openrouter/a', 1_001).consecutiveFailures).toBe(1)
book.record('openrouter/a', { kind: 'success', firstByteMs: 120 }, 2_000)
expect(book.snapshot('openrouter/a', 2_000).consecutiveFailures).toBe(0)
```

- [ ] **Step 2: 写入步骤去重失败测试**

```ts
expect(state.next(agent, 1, 1, [a, b])).toBe(a)
expect(state.next(agent, 1, 1, [a, b])).toBe(b)
expect(state.next(agent, 1, 2, [a, b])).toBe(a)
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/health.spec.ts tests/attempt-state.spec.ts`

Expected: FAIL，因为实现尚不存在。

- [ ] **Step 4: 实现有限窗口与指数冷却**

保留有限成功样本；连续失败以 `baseCooldownMs * 2 ** (n - 1)` 计算并封顶。`AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`QUOTA` 使用 Provider 级 key；其他可重试故障使用模型级 key。`AttemptState` 用 `WeakMap<object, StepAttempts>`，新步骤替换旧集合。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/health.spec.ts tests/attempt-state.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/health.ts src/runtime/attempt-state.ts tests/health.spec.ts tests/attempt-state.spec.ts
git commit -m "feat: track model health and step attempts"
```

## Task 4: 实现 OpenRouter/NVIDIA 目录与无敏感缓存

**Files:**

- Create: `src/catalog/openrouter.ts`
- Create: `src/catalog/nvidia.ts`
- Create: `src/catalog/registry.ts`
- Create: `src/persistence/cache.ts`
- Create: `data/nvidia-models.json`
- Create: `data/model-rankings.json`
- Create: `data/ATTRIBUTION.md`
- Create: `tests/openrouter-catalog.spec.ts`
- Create: `tests/catalog-registry.spec.ts`
- Create: `tests/cache.spec.ts`

**Interfaces:**

- Produces `OpenRouterCatalogSource.load(signal): Promise<CandidateModel[]>`。
- Produces `NvidiaCatalogSource.load(): Promise<CandidateModel[]>`。
- Produces `CatalogRegistry.refresh(executable: Map<string, Set<string>>, signal): Promise<readonly CandidateModel[]>`。
- Produces `RouterCache.load(now): RouterCacheRecord | undefined` 和 `RouterCache.save(record): Promise<void>`。

- [ ] **Step 1: 写入 OpenRouter fixture 测试**

```ts
const models = await source.load(new AbortController().signal)
expect(models.map(({ model }) => model)).toEqual(['org/free-tools:free'])
```

fixture 要包含：付费模型、免费但无 tools 模型、零价格但没有免费路由标记的模型、完整合格模型及缺失字段模型。

- [ ] **Step 2: 写入目录交叉验证与缓存失败测试**

```ts
expect(registry.intersect([nvidiaA, openRouterA], new Map([
  ['nvidia', new Set(['nvidiaA'])],
  ['openrouter', new Set<string>()],
]))).toEqual([nvidiaA])
await cache.save(recordContainingNoSecrets)
expect(JSON.stringify(await cache.load(now))).not.toContain('sk-or-')
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/openrouter-catalog.spec.ts tests/catalog-registry.spec.ts tests/cache.spec.ts`

Expected: FAIL，因为 sources 和 cache 尚未实现。

- [ ] **Step 4: 实现目录和缓存**

OpenRouter source 使用注入的 `fetch`，验证响应结构并只保留免费 tools 模型。NVIDIA source 从 JSON 读取固定目录。Registry 根据 `ctx.llm.listModels()` 的可执行 model ID 交集过滤。缓存写入版本、更新时间、目录、指标和冷却，不接受凭据或任意请求对象；读取时拒绝过期/损坏/版本不兼容记录。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/openrouter-catalog.spec.ts tests/catalog-registry.spec.ts tests/cache.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/catalog src/persistence data tests/openrouter-catalog.spec.ts tests/catalog-registry.spec.ts tests/cache.spec.ts
git commit -m "feat: add free model catalogs and cache"
```

## Task 5: 实现配置与 DSH 路由 runtime

**Files:**

- Modify: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/runtime/router.ts`
- Create: `tests/router.spec.ts`
- Create: `tests/config.spec.ts`

**Interfaces:**

- Produces `FREE_ROUTER_SETTINGS_NAMESPACE = 'free-router'`。
- Produces `createRouterRuntime(deps): RouterRuntime`，其 `onRequest()` 与 `onRequestError()` 返回 DSH waterfall 所需结果。
- Consumes `rankCandidates()`、`HealthBook`、`AttemptState`、`CatalogRegistry`。

- [ ] **Step 1: 写入配置失败测试**

```ts
expect(parseConfig({}).routing.maxAttemptsPerStep).toBe(4)
expect(() => parseConfig({ routing: { maxAttemptsPerStep: 0 } })).toThrow()
expect(() => parseConfig({ providers: { other: { route: 'x' } } })).toThrow()
```

- [ ] **Step 2: 写入 router 失败测试**

```ts
const result = await runtime.onRequest({ agent, turn: 1, step: 1, signal }, () => original)
expect(result).toMatchObject({ provider: 'nvidia', model: 'best-model' })

expect(await runtime.onRequestError(rateLimitPayload, downstream)).toEqual({ kind: 'retry' })
expect(health.isCooling('nvidia/best-model', now)).toBe(true)
```

还必须断言 `UNSUPPORTED_OPTION` 调用下游、不记录重试；没有候选时返回原配置；第四次失败后不再返回 retry。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/config.spec.ts tests/router.spec.ts`

Expected: FAIL，因为 runtime 尚未实现。

- [ ] **Step 4: 实现 Settings 和 waterfall 接线**

`apply(ctx, config)` 注入 `llm`，可选注入 `settings` 并用 `installSection()` 暴露 `free-router` 设置。以 `ctx.on('agent/request', listener, true)` 和 `ctx.on('agent/request-error', listener, true)` 注册 RouterRuntime；采用实际 `payload.agent`、`turn`、`step` 维护尝试集合。选择成功和 failover 均追加非 surface 事件，不把模型信息写入 prompt。重试之前清除 provider-default reasoning effort。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/config.spec.ts tests/router.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts src/config.ts src/runtime/router.ts tests/config.spec.ts tests/router.spec.ts
git commit -m "feat: route agent requests across free models"
```

## Task 6: 加入真实流量观测、探测与生命周期清理

**Files:**

- Modify: `src/runtime/router.ts`
- Modify: `src/index.ts`
- Create: `tests/observation.spec.ts`
- Create: `tests/lifecycle.spec.ts`

**Interfaces:**

- Produces `observeStream(options, next): AsyncIterable<StreamChunk>`。
- Produces `RouterRuntime.start(): void` 与 `RouterRuntime.dispose(): Promise<void>`。

- [ ] **Step 1: 写入流量观测失败测试**

```ts
const chunks = await collect(runtime.observeStream(agentRequest, () => successStream(145)))
expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
expect(health.snapshot('openrouter/model:free', now).averageFirstByteMs).toBe(145)
```

测试失败终止时应断言记录 failure，且辅助 purpose 调用和非 Agent request 不更新路由指标。

- [ ] **Step 2: 写入取消/卸载失败测试**

```ts
runtime.start()
await runtime.dispose()
expect(probeAbort.signal.aborted).toBe(true)
expect(timer.cancelled).toBe(true)
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/observation.spec.ts tests/lifecycle.spec.ts`

Expected: FAIL，因为 stream wrapper 和资源清理尚不存在。

- [ ] **Step 4: 实现观测和探测器**

用不改写 options 的 `llm/stream` wrapper 测量首个 chunk 时间、读取 finish 并更新 HealthBook。以注入时钟/调度器安排初始探测与活跃/闲置周期；所有 `fetch`、探测流和定时器绑定生命周期 AbortController。卸载时 abort、停止调度并等待未完成工作 settle。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/observation.spec.ts tests/lifecycle.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts src/runtime/router.ts tests/observation.spec.ts tests/lifecycle.spec.ts
git commit -m "feat: monitor model health and lifecycle"
```

## Task 7: 完成 DSH 集成、安全和安装 smoke 测试

**Files:**

- Create: `tests/dsh-integration.spec.ts`
- Create: `tests/security.spec.ts`
- Create: `tests/install-smoke.spec.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Consumes: 已构建 bundle、Cordis Context、mock LLM adapter 和 RouterPlugin。
- Produces: 可被 `dsh plugin --profile web add file:<absolute-path>` 安装的构建产物。

- [ ] **Step 1: 写入 DSH 集成失败测试**

```ts
await agent.send('use a tool')
expect(requestHeaders()).toContainEqual(expect.objectContaining({
  provider: 'nvidia', model: 'best-model',
}))
expect(assistantSources()).toContainEqual({ provider: 'openrouter', model: 'fallback:free' })
```

mock 第一个模型返回 `RATE_LIMIT` 终止分片，第二个模型返回 tool call 和成功 finish；断言最终历史只包含成功 assistant message。

- [ ] **Step 2: 写入安全和安装失败测试**

```ts
expect(serializedEvents).not.toContain('sk-or-test-secret')
expect(serializedCache).not.toContain('Bearer')
expect(await installBundle(builtPackage)).toContain('free-router')
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/dsh-integration.spec.ts tests/security.spec.ts tests/install-smoke.spec.ts`

Expected: FAIL，直到 bundle、真实 Context 集成和 redaction 行为齐备。

- [ ] **Step 4: 实现测试 harness 与文档**

建立 mock adapter/Agent Loop fixture；必要时让 integration test 使用本地 DSH checkout 作为开发 peer resolution。README 说明 Node/pnpm 前置条件、安装命令、DSH Models 路由设置、Settings 示例、故障切换范围、隐私保证和 OpenAI-compatible 后续范围。package scripts 增加 `test:unit`、`test:integration`、`test:smoke` 和 `check`。

- [ ] **Step 5: 运行完整验证**

Run: `pnpm run check && pnpm run test:integration && pnpm run test:smoke`

Expected: PASS；无外部 API key 时不执行网络 E2E。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml README.md tests/dsh-integration.spec.ts tests/security.spec.ts tests/install-smoke.spec.ts
git commit -m "test: verify dsh routing bundle integration"
```

## Task 8: 发布前验证与兼容性说明

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `LICENSE`
- Modify: `README.md`
- Modify: `data/ATTRIBUTION.md`
- Create: `docs/release-checklist.md`

**Interfaces:**

- Produces: Node 22 CI，包含 typecheck、unit、integration、build、package 检查。
- Produces: MIT 许可及 free-router 数据归因说明。

- [ ] **Step 1: 写入 CI manifest 失败测试**

```ts
const workflow = await readFile('.github/workflows/ci.yml', 'utf8')
expect(workflow).toContain('node-version: 22')
expect(workflow).toContain('pnpm run check')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/release-files.spec.ts`

Expected: FAIL，因为 release 文件不存在。

- [ ] **Step 3: 写入发布文件并执行 pack 检查**

CI 使用锁定 pnpm、Node 22、`pnpm install --frozen-lockfile` 与完整 check。许可证与归因明确标注数据来源与 MIT。release checklist 包含本地 profile 安装、无密钥启动、OpenRouter/NVIDIA 可选 E2E 和 npm package contents 检查。

- [ ] **Step 4: 运行最终验证**

Run: `pnpm run check && pnpm pack --pack-destination .tmp-pack && npm pack --dry-run`

Expected: PASS；tarball 仅包含 manifest、README、LICENSE、patch、data 与 `dist`。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/ci.yml LICENSE README.md data/ATTRIBUTION.md docs/release-checklist.md tests/release-files.spec.ts
git commit -m "chore: add release validation"
```

## 计划自检

- **规范覆盖：** Task 2 覆盖资格与排序；Task 3 覆盖健康与步骤去重；Task 4 覆盖目录、缓存和数据归因；Task 5 覆盖 Settings、真实 provider/model 与 failover；Task 6 覆盖探测、真实流量、取消与清理；Task 7 覆盖 DSH 集成、安全和安装；Task 8 覆盖发布与兼容性。
- **范围控制：** 不包含独立 Web 面板、私有密钥文件、自有 LLM adapter、辅助模型路由或任意 OpenAI-compatible Provider 实现。
- **类型一致性：** `CandidateModel` 是 catalog、eligibility、ranking、health、attempt state 和 runtime 的共享模型；`HealthBook` 和 `AttemptState` 在 Task 3 定义后由 Task 5、6 消费；`RouterRuntime` 在 Task 5 定义后由 Task 6、7 消费。
- **占位符检查：** 本计划不包含 TBD、TODO、模糊的“适当处理”步骤或未命名的测试。
