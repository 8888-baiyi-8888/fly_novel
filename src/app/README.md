# 应用配置与依赖组装

## 职责

组装小说代码库所需的模块，并提供应用实例的创建入口。

## 内容范围

配置解析与校验、依赖注入、模型及存储实现选择、应用级资源的创建与释放。

当前已实现：

- `main.ts`：CLI 入口，演示「创意草案整理」完整流程。参数：`--input <文本>` / `--file <路径>`（缺省使用示例输入）、`--model memory|real`（默认 memory；real 走项目正式 LLM 机制，当前供应商 qwen）、`--output <路径>`（草案保存到文件）、`--help`（用法与 N0 输入建议）。导出 `buildCreativeDraftAgent()` / `buildRealCreativeDraftAgent()` 供复用。
- `configured-model.ts`：`ConfiguredLlmModel` 桥接——把 `ModelClient` 契约翻译为正式 LLM 机制调用（`src/config` 解密凭据 + `src/llm` 适配器路由 + `callConfiguredLlm`）。
- `llm-adapters.ts`：供应商适配器工厂注册表（当前注册 `deepseek`、`qwen`）。
- `call-llm.ts`：读取配置、按需解密凭据、按 provider 选择适配器并调用。
- `credentials-cli.ts` / `init-encryption-key.ts`：凭据加密与密钥初始化入口（见 `src/config/README.md`）。
- `debug-model.ts`：调试入口，直接调用真实模型并打印原始返回（不经过 JSON 校验）。

## 边界

协调模块的使用，不实现 Agent 执行循环、图调度或小说业务规则。
