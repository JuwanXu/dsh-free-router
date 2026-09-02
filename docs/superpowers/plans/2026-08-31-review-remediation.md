# 复审问题修复实施计划

> **供自动化执行者使用：** 必须使用 `superpowers:executing-plans`，按任务逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 修复复审发现的缓存、生命周期、诊断、Provider 隔离与扩展性问题。

**架构：** 缓存过期后只恢复健康排序数据；运行时显式跟踪活动流并在释放时终止它们。Provider 描述符成为 Provider 配置的唯一声明点，目录故障、候选耗尽和路由缺失则经节流诊断统一报告。

**技术栈：** TypeScript ESM、Vitest、Cordis、DeepSeek Harness。

**设计规格：** `docs/superpowers/specs/2026-08-31-dsh-free-router-design.md`

## 全局约束

- 不实现自有 LLM adapter，所有真实调用继续经 `llm-pi-ai`。
- 日志、缓存和事件不得包含密钥、请求或响应正文。
- 首版 Provider 仍为 OpenRouter 与 NVIDIA NIM；新增 Provider 不应要求修改配置解析分支。
- 每项行为变更先写失败测试并确认失败，再写最小实现。

---

### 任务 1：过期缓存与目录诊断

**涉及文件：**

- 修改：`src/persistence/cache.ts`、`src/catalog/registry.ts`、`src/index.ts`
- 测试：`tests/cache.spec.ts`、`tests/catalog-registry.spec.ts`、`tests/dsh-integration.spec.ts`

- [ ] 写失败测试：过期记录返回空候选但保留健康快照；目录源失败会产生可节流的 Provider 诊断。
- [ ] 运行对应 Vitest 文件，确认当前实现失败。
- [ ] 将过期缓存限制为排序参考，并把目录源失败、缺失路由和候选耗尽接到无敏感信息的节流 warning。
- [ ] 运行对应 Vitest 文件，确认通过。

### 任务 2：运行时卸载与 Provider 隔离

**涉及文件：**

- 修改：`src/runtime/router.ts`、`src/health.ts`、`src/index.ts`
- 测试：`tests/lifecycle.spec.ts`、`tests/router.spec.ts`、`tests/health.spec.ts`

- [ ] 写失败测试：卸载主动结束观测中的流且不再写健康指标；Provider 级故障分类由单一模块提供。
- [ ] 运行对应 Vitest 文件，确认当前实现失败。
- [ ] 跟踪活动迭代器、释放时调用 `return()`，并让 Provider 配置变化只解除已变化路由的配置隔离。
- [ ] 运行对应 Vitest 文件，确认通过。

### 任务 3：描述符驱动的 Provider 配置

**涉及文件：**

- 修改：`src/providers.ts`、`src/config.ts`、`src/index.ts`、`src/runtime/router.ts`
- 测试：`tests/config.spec.ts`、`tests/router.spec.ts`

- [ ] 写失败测试：Provider 默认值与解析结果由描述符产生，未知 Provider 仍被拒绝。
- [ ] 运行对应 Vitest 文件，确认当前实现失败。
- [ ] 将 Provider 配置默认值、键与目录工厂收敛到描述符，并移除无行为的 `providerConfig` 转发函数。
- [ ] 运行对应 Vitest 文件，确认通过。

### 任务 4：回归验证

**涉及文件：**

- 验证：`tests/**/*.spec.ts`、`pnpm run check`

- [ ] 运行完整测试、类型检查与构建。
- [ ] 检查 `git diff --check` 与工作区状态。

### 任务 5：刷新生命周期与拓扑差异

**涉及文件：**

- 修改：`src/index.ts`、`src/catalog/registry.ts`、`src/runtime/router.ts`
- 测试：`tests/catalog-registry.spec.ts`、`tests/lifecycle.spec.ts`、`tests/dsh-integration.spec.ts`

- [ ] 写失败测试：禁用 Provider 不触发目录告警；取消刷新不报告目录失败；中止消费观测流会关闭底层迭代器。
- [ ] 运行对应 Vitest 文件，确认当前实现失败。
- [ ] 跟踪并等待刷新任务，先取消目录请求再释放运行时；仅对可观测到拓扑差异的 Provider 清除隔离。
- [ ] 运行对应 Vitest 文件，确认通过。
