# Task 4 报告：两阶段目录刷新

## 完成内容

- 在 `CatalogRegistry` 新增 `discover(enabledProviders, signal, previous, onSourceFailure)`：按启用 provider 加载目录源；源失败时仅保留该 provider 的旧候选，并通过 provider 标识回调失败，不暴露错误内容；支持已有超时/取消隔离逻辑。
- 新增 `CatalogRegistry.executable(candidates, executable)`：按 provider/model 可执行集合过滤并按 `candidateKey` 去重。
- 在 provider descriptor 中新增 `dynamicRegistration` 标记：OpenRouter 为 `true`，NVIDIA 为 `false`。
- 增加发现先于 adapter 暴露模型、失败源保留、dynamic registration 标记的测试。

## 验证

- `pnpm exec vitest run tests/catalog-registry.spec.ts`：通过（9 tests）。
- `pnpm run test:unit`：通过（12 files，83 tests）。
- `pnpm run typecheck`：通过。

## 注意事项

保留了旧 `refresh()` 作为当前入口迁移期间的兼容 API；后续入口切换到 `discover()` + `executable()` 后可再移除。
