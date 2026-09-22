# N0 真实模型接入正式 LLM 机制

日期：2026-09-22

## 问题

N0（创意草案）接入真实模型时曾使用 `.env` 明文 key + harness 自建 `OpenAICompatibleModel`，与项目正式机制重复且冲突：`src/config` 明确「当前不读取环境变量」，凭据应为加密存储（AES-256-GCM）。同时 novel/draft 的测试位于 `src/novel/draft/` 子目录，未被 `pnpm test` 运行，且被 `tsconfig.build.json` 编进 dist。

## 决定

1. 新增 `src/llm/adapters/openai-compatible.ts`（`OpenAICompatibleAdapter extends LlmAdapter`，支持 qwen / 豆包方舟等兼容端点），在 `src/app/llm-adapters.ts` 注册 `qwen` 供应商。
2. 新增 `src/app/configured-model.ts`（`ConfiguredLlmModel implements ModelClient`）作为桥接：把 harness 契约请求翻译为 `src/llm` 的 `GenerateOptions`，经 `callConfiguredLlm` 走正式配置解密流程；超时默认 180s。
3. `main.ts` / `debug-model.ts` 的真实模型路径改用该桥接；退役 `.env` 通道（删除自建适配器与 `.env.example`）。
4. novel 测试移至 `src/novel/tests/`（符合「测试放 src/*/tests/」约定，`pnpm test` 纳入，`build` 排除）。
5. `settings.example.json` 增加 qwen 样例；README（根 / app / novel / draft）同步。

## 影响

- 用户需按 `src/config/README.md` 完成本机配置：`pnpm run init-encryption-key` → `pnpm run credentials encrypt` → 填写 `.fly-novel/settings.json` 与 `.credentials.json`。
- harness / novel 仍只依赖 `ModelClient` 契约，不直接读取应用配置。

## 验证

- `pnpm run typecheck` 通过。
- `pnpm test`：novel 15 个用例进入项目测试体系；新增 openai-compatible 适配器测试 3 个。
- `pnpm run build` 后 `dist/` 不含任何 `*.test.js`。
- 已知遗留（非本变更引入）：`src/config/paths.ts` 的 `APP_HOME` 仍写死 `D:/mydata/GitHub/fly_novel/.fly-novel`，与本机 `E:\typescript\fly_novel` 不一致，导致 `pnpm test` 中 settings 用例失败；待单独修复。
