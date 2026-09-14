# DSH Resilience Suite Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `dsh-free-router`、`dsh-camel` 和 `dsh-continue` 安装到同一个本地 DSH web profile，并验证免费模型的切换、限流等待和网络续行。

**Architecture:** 三个插件使用 DSH 的 request / request-error waterfall 组合运行。free-router 对健康免费候选进行选路和故障切换；camel 只在没有可切换候选时安排限流等待；continue 只处理非 `RATE_LIMIT` 的网络与低风险续行场景。

**Tech Stack:** Node.js 22、DeepSeek Harness `0.1.5-rc.1`、pnpm、Vitest、OpenRouter、YAML。

**Spec:** `docs/superpowers/specs/2026-09-14-free-router-camel-integration-design.md`

## Global Constraints

- 只使用公开发布的 `dsh-free-router@0.1.0`、`dsh-camel@0.2.1`、`dsh-continue@0.2.1`，除非测试证明已发布包存在缺陷。
- 修改 `~/.dsh` 前备份 `settings.yaml` 和整个 `profiles/web` 目录；不得读取、打印、移动或删除凭据文件。
- OpenRouter 仅保留至少两个当前可用的、具体的 `:free` 模型，不使用聚合标识 `openrouter/free` 作为唯一候选。
- `dsh-continue` 的网络错误码不得包含 `RATE_LIMIT`。
- 所有真实请求使用不含业务数据的最小中文验证提示。

---

### Task 1: 发布包与现有实现准入

**Files:**
- Read: `package.json`
- Read: `src/runtime/router.ts`
- Test: npm 已发布包的 tarball 元数据与本地 `dsh-free-router` 测试套件

**Interfaces:**
- Consumes: npm 包 `dsh-free-router@0.1.0`、`dsh-camel@0.2.1`、`dsh-continue@0.2.1`
- Produces: 已确认的 bundle 名、安装版本和 `RATE_LIMIT` 职责边界

- [ ] **Step 1: 检查三个发布包的元数据和 bundle 声明**

Run:

```bash
npm view dsh-free-router@0.1.0 name version repository --json
npm view dsh-camel@0.2.1 name version repository --json
npm view dsh-continue@0.2.1 name version repository --json
```

Expected: 包名、版本和 GitHub 仓库均与参赛材料一致。

- [ ] **Step 2: 运行 free-router 回归测试**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: 所有测试和类型检查通过；否则停止配置并先定位失败文件。

- [ ] **Step 3: 记录协作边界**

Expected: free-router 可在 `RATE_LIMIT` 返回 retry 时切换候选；camel 对下游已有 retry 原样返回；continue 的默认 `network.codes` 不包含 `RATE_LIMIT`。

### Task 2: 安全组合本地 DSH Profile

**Files:**
- Modify: `~/.dsh/profiles/web/package.json`
- Modify: `~/.dsh/settings.yaml`
- Create: `~/.dsh/backups/resilience-suite-<timestamp>/`

**Interfaces:**
- Consumes: DSH `plugin --profile web add` 与 YAML 配置层
- Produces: 同时装载三个 bundle、两个 OpenRouter 免费模型的可启动 profile

- [ ] **Step 1: 创建可恢复备份**

Run:

```bash
backup_dir="/Users/xuzhiwei/.dsh/backups/resilience-suite-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp "/Users/xuzhiwei/.dsh/settings.yaml" "$backup_dir/settings.yaml"
cp -R "/Users/xuzhiwei/.dsh/profiles/web" "$backup_dir/web"
```

Expected: 备份同时包含配置和 profile，但不读取 `.credentials.yaml`。

- [ ] **Step 2: 添加已发布的两个续航插件**

Run:

```bash
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile web add dsh-camel@0.2.1 dsh-continue@0.2.1
```

Expected: web profile 的 bundles 同时包含 `dsh-free-router`、`dsh-camel`、`dsh-continue`。

- [ ] **Step 3: 写入组合配置**

Set `/Users/xuzhiwei/.dsh/settings.yaml` to the following relevant values:

```yaml
agent-default-model:
  provider: openrouter
  model: nvidia/nemotron-3.5-lightning:free
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      baseURL: https://openrouter.ai/api/v1
      retryPolicy: { mode: normal, maxRetries: 0 }
      models:
        - id: nvidia/nemotron-3.5-lightning:free
          name: NVIDIA Nemotron 3.5 Lightning (free)
        - id: nex-agi/nex-n2.5-mini:free
          name: Nex AGI Nex-N2.5-Mini (free)
free-router:
  enabled: true
  providers:
    openrouter: { enabled: true, route: openrouter }
    nvidia: { enabled: false, route: nvidia }
  routing:
    maxAttemptsPerStep: 2
    includeModels:
      - nvidia/nemotron-3.5-lightning:free
      - nex-agi/nex-n2.5-mini:free
```

Set `/Users/xuzhiwei/.dsh/profiles/web/cordis.patch.yml` to include these loader overrides:

```yaml
- id: camel
  config:
    defaults:
      throttle: { enabled: true, maxRequests: 5, windowMs: 60000, scope: route }
      retry:
        enabled: true
        codes: [RATE_LIMIT]
        mode: unlimited
        fallbackDelayMs: 1000
        initialDelayMs: 1000
        multiplier: 2
        maxLocalDelayMs: 5000
        respectRetryAfter: true
- id: continue
  config:
    defaults:
      network:
        enabled: true
        codes: [TIMEOUT, TRANSPORT, SERVER]
        mode: unlimited
        initialDelayMs: 1000
        multiplier: 2
        maxDelayMs: 5000
        respectRetryAfter: true
      recommended: { enabled: true, labelSuffixes: ['(Recommended)', '（推荐）'], onMissingRecommendation: ask, maxRepeatedQuestion: 3 }
      continuation:
        enabled: true
        autoApprovePlan: false
        autoConfirmContinue: true
        affirmativeLabels: [Continue, Proceed, Yes, 继续, 执行, 确认]
        negativeLabels: [Stop, Cancel, No, 停止, 取消, 否]
        plainTextFallback: false
        plainTextPatterns: [是否继续, 需要我继续吗, 要继续吗, Do you want me to continue]
        riskBlockPatterns: [删除, 覆盖, 销毁, 清空, 截断, 发送, 发邮件, 采购, 购买, 下单, 提权, 权限提升, 发布, 部署, 付款, 凭据, 密钥, 密码, 生产环境, delet, remov, destroy, wipe, truncate, drop table, overwrite, send, email, purchase, procure, place order, sudo, privilege, elevat, admin access, publish, release, deploy, payment, credential, secret, password, api key, production, irreversible]
        maxAutoDecisionsPerTurn: 8
        maxPlainTextSteersPerTurn: 1
      promptPolicy:
        enabled: false
        text: 对非关键决策采用明确推荐方案并继续，不要仅为了询问是否继续而停止。
```

Expected: `npx --yes @deepseek-ai/dsh@0.1.5-rc.1 --dump-config` accepts the profile with no unknown plugin/config errors.

### Task 3: 可控故障链路验证

**Files:**
- Test: `src/runtime/router.spec.ts`（仅当现有单元测试未覆盖两候选 `RATE_LIMIT` 切换时）
- Test: DSH web profile 的会话事件和 `~/.dsh/cache/free-router.json`

**Interfaces:**
- Consumes: `free-router/selected`、`free-router/failover`、`llm/retry`、`llm/retry-started` session events
- Produces: 限流切换和候选耗尽等待的可观察证据

- [ ] **Step 1: 验证 free-router 候选目录**

Run:

```bash
jq '.candidates | map({provider, model, displayName})' "/Users/xuzhiwei/.dsh/cache/free-router.json"
```

Expected: 至少两个 OpenRouter 具体免费模型进入候选目录。

- [ ] **Step 2: 验证首选候选限流时的切换**

Use a controlled LLM adapter failure that returns `{ code: 'RATE_LIMIT' }` for the first candidate and succeeds for the second.

Expected: `free-router/failover` references the first and second models; the retry request uses the second model; no camel wait event is created.

- [ ] **Step 3: 验证候选耗尽后的 camel 兜底**

Return `RATE_LIMIT` for every configured candidate.

Expected: free-router reports exhaustion and camel writes exactly one `llm/retry` followed by `llm/retry-started`; continue does not write a `RATE_LIMIT` retry event.

### Task 4: 真实 DSH 启动与最小请求验收

**Files:**
- Read: `~/.dsh/profiles/web/package.json`
- Read: `~/.dsh/settings.yaml`（仅非凭据字段）
- Read: `~/.dsh/cache/free-router.json`

**Interfaces:**
- Consumes: 本机 OpenRouter 凭据和 DSH Web UI
- Produces: 可持续运行的本地 DSH 服务及免费模型成功健康记录

- [ ] **Step 1: 启动 DSH Web profile**

Run:

```bash
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 web
```

Expected: 服务监听本地端口且自动完成浏览器授权；三个 bundle 均加载。

- [ ] **Step 2: 发送无业务数据的真实请求**

Prompt:

```text
只回复：DSH 三插件联动验证成功
```

Expected: 当前免费模型给出成功响应，缓存将该候选标记为 `available`。

- [ ] **Step 3: 收集验收结论**

Expected: 记录 DSH 版本、三个已安装版本、两个配置模型、端口监听状态和健康缓存结果；不输出 token 或 API Key。

### Task 5: 故障修复与复验

**Files:**
- Modify: 仅由失败测试定位到的插件源文件
- Test: 修改模块对应的 Vitest 文件与所有受影响 workspace package 的 build/typecheck

**Interfaces:**
- Consumes: Task 3/4 的可复现失败证据
- Produces: 最小修复、回归测试和重复的真实 DSH 验收

- [ ] **Step 1: 将每个失败归类为 profile 配置、发布包兼容性或插件运行时问题**

Expected: 配置问题只修改 `~/.dsh`；发布包兼容性问题先在对应源仓库用失败测试复现；不修改无关的用户工作区文件。

- [ ] **Step 2: 先写最小失败测试，再实现修复**

Expected: 测试覆盖失败的错误码、候选选择和 session event 行为；修复不新增跨插件硬依赖。

- [ ] **Step 3: 运行完整验证并记录修复结果**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: 全部通过后重跑 Task 3 和 Task 4，确认真实 profile 已恢复。
