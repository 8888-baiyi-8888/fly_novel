# 2026-09-14：创意草案模块（novel/draft）

## 问题

项目处于骨架期（仅配置与 README，无源码）。需要落地第一个可运行的垂直切片，验证 harness/model → novel 业务 → app 组装的完整链路。

## 决定

- 实现「创意草案整理」轻量 Agent：一次模型调用 + 结构化输出校验 + 有限重试（默认 1 次）。
- 模型访问通过 `harness/model` 的 `ModelClient` 接口注入；演示/测试用 `MemoryModel`（预置响应），不引入真实供应商与凭据。
- 草案校验用自写类型谓词实现，不引入 ajv 等依赖（当前规模零依赖更稳）。
- 测试用 Node 内置 `node:test`，随构建产物放 `dist/`，`npm test` 前需先 build。
- 数据格式：`CreativeDraft` 带 `schemaVersion: 1`，未来格式变化走版本校验。

## 影响

- 新增文件：`src/harness/model/*`、`src/harness/adapters/models/memory-model.ts`、`src/novel/draft/*`、`src/app/main.ts`、`creative-draft-agent.test.ts`。
- package.json 增加 `test`、`demo` 脚本；根 README、src/novel、src/app README 同步更新。
- 后续建书各步复用同一模式：契约 → 校验 → 提示词 → 轻量 Agent → 组装。

## 验证

- `npm run typecheck` / `npm run build` 通过。
- `npm test` 覆盖：校验成功/必填缺失/版本不匹配、Agent 成功路径、非法 JSON 重试、重试耗尽报错、空输入不调模型。
- `npm run demo` 输出结构化草案 JSON。
