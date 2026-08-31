# 发布检查清单

## 本地验证

1. 使用 Node.js 22.19+ 与 pnpm 11.7.0 执行 `pnpm install --frozen-lockfile`。
2. 执行 `pnpm run check && pnpm run test:integration && pnpm run test:smoke`。
3. 执行 `pnpm pack --pack-destination .tmp-pack`，确认 tarball 仅含 `dist`、`data`、`README.md`、`LICENSE`、`package.json` 和 `cordis.patch.yml`。
4. 在干净的完整 DSH profile 中执行 `dsh plugin --profile web add file:/绝对路径/dsh-free-router`。
5. 未设置任何 Provider 凭据时启动 DSH，确认插件保留原模型配置且不报错。

## 可选真实连通性

1. 只配置 NVIDIA NIM 凭据，确认可选择静态目录中的免费 tool-calling 模型。
2. 只配置 OpenRouter 凭据，确认实时目录只纳入免费且支持 tools 的模型。
3. 同时配置两个 Provider，制造单模型限流或临时服务错误，确认后续尝试切换到不同候选。
4. 检查 Settings、日志与缓存文件，确认没有 API key、Bearer header 或原始请求内容。

## 发布资料

1. 核对 `LICENSE` 为 MIT，`data/ATTRIBUTION.md` 保留模型 Tier 数据来源与许可。
2. 审核 README 的 DSH 版本、安装命令和 Provider 配置示例是否仍与当前 DSH 匹配。
3. 变更静态 NVIDIA 目录或 Tier 映射时，更新归因说明、测试 fixture 和版本号。
