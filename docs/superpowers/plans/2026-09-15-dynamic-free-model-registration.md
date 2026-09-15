# Dynamic Free Model Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `dsh-free-router` 中把动态发现的合格 OpenRouter 免费模型登记为 DSH 可选择、可设默认且可自动故障切换的模型。

**Architecture:** 插件保留用户的 `openrouter` 连接路由，并维护独立的 `free-router-openrouter` 托管路由。刷新时先发现原始候选，再通过 DSH Settings path mutation 登记模型，等待官方 `llm-pi-ai` adapter 重建后读回实际可执行模型，最后交给既有选路和健康模块。

**Tech Stack:** TypeScript 5.8、Vitest 3、Cordis 4、DSH Settings、`@deepseek-ai/dsh-llm-pi-ai`、Node.js 22.19+。

**Spec:** `docs/superpowers/specs/2026-09-15-dynamic-free-model-registration-design.md`

## Global Constraints

- 仅修改现有插件；不注册虚拟 LLM adapter，不调用 `llm-pi-ai` 私有 API，不修改 DSH 核心。
- 不修改 `llm-pi-ai.providers.openrouter` 或任何其他用户路由；只写入注册器指定的目标路由。
- 不读取、缓存、记录或输出 API Key、Authorization header、prompt 或响应；只复制 `apiKeyEnv` 等凭据引用。
- 只登记免费、支持工具调用、通过现有上下文/Tier/包含排除策略的模型。
- 目录、Settings 或 adapter 读取失败时保留上一批成功验证的候选；不得用空结果覆盖托管模型。
- 使用 `settings.mutate()` path op，不使用 `settings.replace()`；目标冲突、来源缺失、路由同名或所有权不匹配时拒绝写入。
- `registration.openrouter.enabled` 默认 `false`，确保旧安装不改变行为。
- 插件自己触发的 `llm/adapters-updated` 只做一次回读复核，必须消除刷新循环。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 新注册器设置、默认值与来源/目标校验。 |
| `src/registration/types.ts` | 托管路由计划、缓存声明与协调结果的纯类型。 |
| `src/registration/managed-route.ts` | 安全投影来源路由、模型条目和稳定静态签名。 |
| `src/registration/reconciler.ts` | 所有权检查、path mutation 与幂等判断。 |
| `src/catalog/registry.ts` | 拆分目录发现和 adapter 可执行性过滤。 |
| `src/providers.ts` | 标记目录源是否允许动态登记，避免 NVIDIA 首期误入登记路径。 |
| `src/persistence/cache.ts` | v2 缓存、v1 兼容和声明 allowlist。 |
| `src/index.ts` | 登记与 adapter 生命周期协调。 |
| `tests/*registration*.spec.ts` | 新注册器单元和 Cordis 集成覆盖。 |
| `README.md`、`docs/README.zh-CN.md` | 启用、冲突、关闭和默认模型说明。 |

### Task 1: 注册器配置契约

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.spec.ts`

**Interfaces:**
- Produces `OpenRouterRegistrationConfig { enabled: boolean; route: string; displayName: string }`。
- Produces `RouterConfig.registration.openrouter`。

- [ ] **Step 1: 写失败测试**

```ts
it('keeps dynamic registration disabled by default', () => {
  expect(parseConfig({}).registration.openrouter).toEqual({
    enabled: false,
    route: 'free-router-openrouter',
    displayName: 'Free Router · OpenRouter',
  })
})

it('rejects an enabled registrar targeting its source route', () => {
  expect(() => parseConfig({
    providers: { openrouter: { route: 'openrouter' } },
    registration: { openrouter: { enabled: true, route: 'openrouter' } },
  })).toThrow(/must differ/)
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/config.spec.ts`

Expected: FAIL，`registration` 未定义或被识别为未知字段。

- [ ] **Step 3: 实现配置和校验**

在 `src/config.ts` 增加：

```ts
export interface OpenRouterRegistrationConfig {
  enabled: boolean
  route: string
  displayName: string
}

const defaultRegistration = {
  openrouter: {
    enabled: false,
    route: 'free-router-openrouter',
    displayName: 'Free Router · OpenRouter',
  },
} as const
```

将 `registration` 接入 `RouterConfig`、`defaultConfig`、`Config` schema、`unknownTopLevel` 和 `parseConfig()`。`route`、`displayName` 必须非空；仅在启用时拒绝它与 `providers.openrouter.route` 相等。

- [ ] **Step 4: 覆盖成功和无效输入**

```ts
it('accepts a distinct managed route', () => {
  expect(parseConfig({ registration: { openrouter: {
    enabled: true, route: 'free-router-or', displayName: 'Managed OR',
  } } }).registration.openrouter.route).toBe('free-router-or')
})

it.each([
  { registration: { openrouter: { route: '' } } },
  { registration: { openrouter: { displayName: '' } } },
])('rejects malformed registration %#', (value) => expect(() => parseConfig(value)).toThrow())
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm exec vitest run tests/config.spec.ts && pnpm run typecheck`

Expected: PASS。

```bash
git add src/config.ts tests/config.spec.ts
git commit -m "feat: add dynamic registration configuration"
```

### Task 2: 托管路由投影

**Files:**
- Create: `src/registration/types.ts`
- Create: `src/registration/managed-route.ts`
- Create: `tests/managed-route.spec.ts`

**Interfaces:**
- Produces `ManagedRouteClaim { sourceRoute: string; targetRoute: string; profileSignature: string; modelIds: string[] }`。
- Produces `ManagedRoutePlan { targetRoute: string; profile: Record<string, unknown>; claim: ManagedRouteClaim }`。
- Produces `planManagedRoute(sourceProfile, sourceRoute, registration, candidates): ManagedRoutePlan`。

- [ ] **Step 1: 写安全投影的失败测试**

```ts
const plan = planManagedRoute({
  apiKeyEnv: 'OPENROUTER_API_KEY',
  baseURL: 'https://openrouter.ai/api/v1',
  api: 'openai-completions',
  retryPolicy: { mode: 'normal', maxRetries: 0 },
  models: [{ id: 'manual' }],
  apiKey: 'must-not-copy',
} as never, 'openrouter', registration, [candidate('b:free'), candidate('a:free')])

expect(plan.profile).toMatchObject({
  apiKeyEnv: 'OPENROUTER_API_KEY',
  displayName: 'Free Router · OpenRouter',
  models: [{ id: 'a:free' }, { id: 'b:free' }],
})
expect(JSON.stringify(plan)).not.toContain('must-not-copy')
expect(plan.profile).not.toHaveProperty('modelOverrides')
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/managed-route.spec.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 allowlist 投影与指纹**

在 `src/registration/types.ts` 定义上述接口。在 `managed-route.ts` 仅复制下列字段：

```ts
const COPIED_PROFILE_FIELDS = [
  'apiKeyEnv', 'api', 'baseURL', 'headers', 'retryPolicy', 'compat',
  'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning',
  'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs',
  'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes',
  'requestImagePixelBudget', 'requestImageMaxBytes',
] as const
```

深复制 JSON 值；按模型 ID 排序、去重并投影为 `{ id, name, contextWindow }`；强制目标 `displayName`。递归按键排序后序列化 `sourceRoute`、`targetRoute` 和非模型静态 profile，生成 `profileSignature`。不复制来源 `models`、`modelOverrides`、`displayName` 或任何未知字段。

- [ ] **Step 4: 覆盖确定性与不变性**

```ts
it('creates equal plans regardless of catalog order', () => {
  expect(planManagedRoute(source, 'openrouter', registration, [candidate('b:free'), candidate('a:free')]))
    .toEqual(planManagedRoute(source, 'openrouter', registration, [candidate('a:free'), candidate('b:free')]))
})

it('does not mutate inputs', () => {
  const source = { headers: { 'X-Test': 'source' } }
  const models = [candidate('a:free')]
  planManagedRoute(source, 'openrouter', registration, models)
  expect(source).toEqual({ headers: { 'X-Test': 'source' } })
  expect(models).toEqual([candidate('a:free')])
})
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm exec vitest run tests/managed-route.spec.ts && pnpm run typecheck`

Expected: PASS。

```bash
git add src/registration/types.ts src/registration/managed-route.ts tests/managed-route.spec.ts
git commit -m "feat: plan managed OpenRouter routes"
```

### Task 3: 缓存 v2 与所有权协调

**Files:**
- Modify: `src/persistence/cache.ts`
- Modify: `tests/cache.spec.ts`
- Create: `src/registration/reconciler.ts`
- Create: `tests/registration-reconciler.spec.ts`

**Interfaces:**
- Produces `reconcileManagedRoute(providers, plan, previousClaim)`。
- Result is `{ kind: 'create' | 'update' | 'unchanged'; ops: SettingsPathOp[]; claim: ManagedRouteClaim } | { kind: 'conflict'; reason: 'target-exists' | 'ownership-mismatch' }`。
- `RouterCacheRecord` v2 contains `registrations: { openrouter?: ManagedRouteClaim }`。

- [ ] **Step 1: 写 v1 迁移与目标冲突失败测试**

```ts
it('migrates a v1 cache with no claim', async () => {
  await writeFile(path, JSON.stringify({ ...record, version: 1 }))
  await expect(cache.load(1_500)).resolves.toMatchObject({ version: 2, registrations: {} })
})

it('does not overwrite an unmanaged target', () => {
  expect(reconcileManagedRoute({
    'free-router-openrouter': { apiKeyEnv: 'OTHER_KEY', models: [{ id: 'keep-me' }] },
  }, plan, undefined)).toEqual({ kind: 'conflict', reason: 'target-exists' })
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/cache.spec.ts tests/registration-reconciler.spec.ts`

Expected: FAIL，缓存不迁移且协调器模块不存在。

- [ ] **Step 3: 实现 v2 安全缓存**

将缓存版本升为 `2`。`load()` 接受合规 v1 并返回 v2 空 `registrations`；v2 仅接受非空 `sourceRoute`、`targetRoute`、`profileSignature` 和无重复非空 `modelIds`。`writeRecord()` 只允许写声明的四类字段，不写 profile、headers 或 credential 值。

- [ ] **Step 4: 实现协调器**

```ts
export function reconcileManagedRoute(
  providers: Record<string, unknown>,
  plan: ManagedRoutePlan,
  previousClaim: ManagedRouteClaim | undefined,
): ReconcileResult
```

目标不存在：返回单个 `set ['providers', targetRoute]` 的 `create`。目标存在但无匹配声明：`target-exists`。声明匹配但安全静态字段不等：`ownership-mismatch`。静态字段与 models 都等：`unchanged`。只有 models 不等：返回单个 `set ['providers', targetRoute, 'models']` 的 `update`。比较使用深 JSON 相等，不根据路由名字或模型数量推断所有权。

- [ ] **Step 5: 覆盖秘密剔除与幂等更新**

```ts
it('writes only the managed models path on a valid update', () => {
  const result = reconcileManagedRoute(existingManagedProviders, changedPlan, claim)
  expect(result).toMatchObject({ kind: 'update' })
  expect(result.ops).toEqual([{ op: 'set', path: ['providers', 'free-router-openrouter', 'models'], value: changedPlan.profile.models }])
})

it('never persists headers or secret-like values', async () => {
  await cache.save({ ...recordV2, registrations: { openrouter: claim } })
  expect(await readFile(path, 'utf8')).not.toMatch(/Authorization|sk-or-test-secret/)
})
```

- [ ] **Step 6: 验证并提交**

Run: `pnpm exec vitest run tests/cache.spec.ts tests/registration-reconciler.spec.ts && pnpm run typecheck`

Expected: PASS。

```bash
git add src/persistence/cache.ts src/registration/reconciler.ts tests/cache.spec.ts tests/registration-reconciler.spec.ts
git commit -m "feat: persist managed route ownership"
```

### Task 4: 两阶段目录刷新

**Files:**
- Modify: `src/catalog/registry.ts`
- Modify: `src/providers.ts`
- Modify: `tests/catalog-registry.spec.ts`

**Interfaces:**
- Produces `CatalogRegistry.discover(enabledProviders, signal, previous, onSourceFailure)`。
- Produces `CatalogRegistry.executable(candidates, executable)`。

- [ ] **Step 1: 写失败测试**

```ts
it('discovers an enabled source before an adapter exposes its models', async () => {
  const registry = new CatalogRegistry([
    { provider: 'openrouter', load: async () => [candidate('openrouter', 'new:free')] },
  ])
  const discovered = await registry.discover(new Set(['openrouter']), new AbortController().signal)
  expect(discovered).toEqual([candidate('openrouter', 'new:free')])
  expect(registry.executable(discovered, new Map([['openrouter', new Set()]]))).toEqual([])
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/catalog-registry.spec.ts`

Expected: FAIL，`discover` 和 `executable` 不存在。

- [ ] **Step 3: 实现 API 分离**

`discover()` 只依据启用 provider 集合加载源；失败时只保留 `previous` 中该 provider 候选并调用无敏感 `onSourceFailure`。`executable()` 做 provider/model 相交和去重。删除旧 `refresh()` 的前置可执行性加载条件，保证首次登记目标路由前仍能获得 OpenRouter 原始目录。

在 `src/providers.ts` 的 descriptor 中新增 `dynamicRegistration: boolean`；仅 OpenRouter 为 `true`，NVIDIA 为 `false`。入口只允许带该标记的源进入托管登记逻辑。

- [ ] **Step 4: 更新失败/超时/取消/禁用覆盖**

```ts
it('retains only candidates from a failed source', async () => {
  const registry = new CatalogRegistry([
    { provider: 'openrouter', load: async () => { throw new Error('unavailable') } },
    { provider: 'nvidia', load: async () => [candidate('nvidia', 'fresh')] },
  ])
  await expect(registry.discover(new Set(['openrouter', 'nvidia']), new AbortController().signal,
    [candidate('openrouter', 'cached')],
  )).resolves.toEqual([candidate('nvidia', 'fresh'), candidate('openrouter', 'cached')])
})
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm exec vitest run tests/catalog-registry.spec.ts && pnpm run test:unit`

Expected: PASS。

```bash
git add src/catalog/registry.ts src/providers.ts tests/catalog-registry.spec.ts
git commit -m "refactor: separate catalog discovery from execution checks"
```

### Task 5: 生命周期编排与 DSH 集成

**Files:**
- Modify: `src/index.ts`
- Create: `tests/dynamic-registration-integration.spec.ts`
- Modify: `tests/dsh-integration.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 1–4 的配置、计划、协调器、目录发现和执行过滤接口。
- Produces“发现→登记→adapter 回读→托管 provider 候选”的刷新路径。

- [ ] **Step 1: 写完整失败集成测试**

使用 Cordis `Context`、Settings 桩和 LLM 桩。Settings 初始含 `llm-pi-ai.providers.openrouter`；`mutate()` 应用 path op 后 emit `llm/adapters-updated`；LLM 仅在目标被登记后暴露 `free-router-openrouter` 两个模型。

```ts
expect(settingsMutations).toEqual([expect.objectContaining({
  ns: 'llm-pi-ai',
  ops: [expect.objectContaining({
    path: ['providers', 'free-router-openrouter'],
    value: expect.objectContaining({
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: [expect.objectContaining({ id: 'first:free' }), expect.objectContaining({ id: 'second:free' })],
    }),
  })],
})])
expect(await requestThroughWaterfall(ctx)).toMatchObject({
  provider: 'free-router-openrouter', model: 'first:free',
})
```

- [ ] **Step 2: 运行失败集成测试**

Run: `pnpm exec vitest run tests/dynamic-registration-integration.spec.ts`

Expected: FAIL，没有 `llm-pi-ai` mutation，且请求不会选择托管路由。

- [ ] **Step 3: 在入口编排注册器**

在 `ctx.inject(['settings'], ...)` 中读取 `settings.get('llm-pi-ai')` 的已注册配置，获得来源 `providers[config.providers.openrouter.route]`。启用注册器后执行：

```ts
const discovered = await catalog.discover(enabledSources(config), signal, previousSourceCandidates, onCatalogFailure)
const eligibleOpenRouter = discovered.filter((candidate) => candidate.provider === 'openrouter' && eligible(candidate, config.routing))
const plan = planManagedRoute(sourceProfile, sourceRoute, registration, eligibleOpenRouter)
const result = reconcileManagedRoute(providerProfiles, plan, cachedClaim)
if (result.kind === 'create' || result.kind === 'update') {
  await ctx.settings.mutate('llm-pi-ai', result.ops)
  pendingManagedAdapterVerification = result.claim
  return
}
const executable = await executableModels(ctx, effectiveRoutes(config), previousCandidates, signal, timeoutMs)
candidates = mapOpenRouterToManagedRoute(catalog.executable(discovered, executable.models), config)
```

`effectiveRoutes()` 在登记开启时把 OpenRouter 映射到目标路由，NVIDIA 保持原映射。增加 `refreshInFlight`、`refreshQueued`、`pendingManagedAdapterVerification`：相同计划不会 mutate；由本插件写设置触发的 adapter 事件只回读 `listModels(targetRoute)` 一次；外部 adapter 事件保留现有隔离刷新语义。dispose 后不得启动新刷新或写设置。

初始刷新必须在 `settings` 注入完成后才进入登记分支：无 Settings 服务或注册器关闭时沿用当前启动路径；Settings 服务存在且注册器开启时，先读取来源 profile，再排入首个刷新任务。来源 profile 缺失时不调用 `mutate()`，保留上一候选并输出不含 profile 内容的诊断。

- [ ] **Step 4: 覆盖失败保留、冲突、循环和限流切换**

```ts
it('does not overwrite an unmanaged target route', async () => {
  settingsDocument['llm-pi-ai'].providers['free-router-openrouter'] = { apiKeyEnv: 'OTHER_KEY' }
  await startPlugin()
  expect(settingsMutations).toEqual([])
})

it('does not write again after its own adapter update', async () => {
  await startWithSuccessfulManagedRegistration()
  await waitForRefresh()
  expect(settingsMutations).toHaveLength(1)
})

it('leaves an existing managed route untouched when registration is disabled', async () => {
  await startPlugin({ registration: { openrouter: { enabled: false } } })
  expect(settingsMutations).toEqual([])
})

it('fails over between dynamically registered models after RATE_LIMIT', async () => {
  const first = await requestThroughWaterfall(ctx)
  await reportFailure(ctx, first, 'RATE_LIMIT')
  expect(await requestThroughWaterfall(ctx)).toMatchObject({
    provider: 'free-router-openrouter', model: 'second:free',
  })
})
```

另加目录失败后仍能选中上一托管候选的用例，以及诊断不包含插入来源 profile 的 `Authorization`、API key 或目录错误正文的断言。

- [ ] **Step 5: 更新集成脚本并验证**

将 `tests/dynamic-registration-integration.spec.ts` 加入：

```json
"test:integration": "vitest run tests/dsh-integration.spec.ts tests/agent-loop-integration.spec.ts tests/dynamic-registration-integration.spec.ts"
```

Run: `pnpm run test:integration && pnpm run test && pnpm run typecheck && pnpm run build`

Expected: PASS；测试不访问真实 OpenRouter 或 API Key。

- [ ] **Step 6: 提交集成**

```bash
git add src/index.ts tests/dynamic-registration-integration.spec.ts tests/dsh-integration.spec.ts package.json
git commit -m "feat: register dynamic free models with DSH"
```

### Task 6: 文档、打包和最终验证

**Files:**
- Modify: `README.md`
- Modify: `docs/README.zh-CN.md`
- Modify: `tests/package.spec.ts`
- Modify: `tests/release-files.spec.ts`

**Interfaces:**
- 用户文档提供可复制的来源 `openrouter` 与托管 `free-router-openrouter` YAML。
- 发行包保留用户文档，不包含 `docs/superpowers` 内部记录。

- [ ] **Step 1: 写文档与包内容失败断言**

```ts
expect(readme).toContain('free-router-openrouter')
expect(readme).toContain('registration:')
expect(chineseReadme).toContain('自动登记')
expect(packageFiles.some((file) => file.includes('/docs/superpowers/'))).toBe(false)
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/package.spec.ts tests/release-files.spec.ts`

Expected: FAIL，README 尚未说明 `registration`。

- [ ] **Step 3: 更新用户文档**

在英文 README 添加 “Dynamic OpenRouter registration”，给出完整 YAML，说明 DSH 下拉列表会出现 `Free Router · OpenRouter`，这些模型可设默认。说明关闭只停止同步、不会删除路由。

在中文文档添加“动态登记 OpenRouter 免费模型”，明确原始 `openrouter` 不被改写；仅合格免费工具模型出现；目标冲突时改 `registration.openrouter.route`；目录短暂失败保留上一成功列表。

- [ ] **Step 4: 更新包测试并干打包验证**

```ts
it('ships user documentation but excludes internal planning records', async () => {
  expect(files).toContain('package/docs/README.zh-CN.md')
  expect(files.some((file) => file.includes('/docs/superpowers/'))).toBe(false)
})
```

Run: `pnpm exec vitest run tests/package.spec.ts tests/release-files.spec.ts && pnpm pack --dry-run`

Expected: PASS；包含 `README.md`、`docs/README.zh-CN.md`、`dist`、`data`，不含内部规格和计划。

- [ ] **Step 5: 最终验证并提交**

Run: `pnpm run check && pnpm run test:integration && pnpm run test:smoke && pnpm pack --dry-run && git diff --check`

Expected: PASS，工作树只包含本功能的预期文件。

```bash
git add README.md docs/README.zh-CN.md tests/package.spec.ts tests/release-files.spec.ts
git commit -m "docs: explain dynamic free model registration"
```
