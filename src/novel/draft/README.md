# 创意草案整理（novel/draft）

## 职责

对应建书第 1 步：把用户散乱的自然语言想法整理成结构化创意草案（Creation Draft）。

## 内容范围

| 文件 | 说明 |
|---|---|
| `types.ts` | `CreativeDraft` / `ProtagonistDraft` / `SupportingCastDraft` 类型定义（v2：多主角数组 `protagonists`；字段只记录相对稳定属性） |
| `schema.ts` | 结构化输出描述 `DRAFT_JSON_DESCRIPTION`（供提示词与模型契约使用） |
| `validate.ts` | `parseAndValidateDraft` 校验器 + `DraftValidationError`（校验失败抛错；兼容 v1 迁移） |
| `prompt.ts` | `buildDraftMessages` 组装系统/用户消息 |
| `example.ts` | 演示/测试数据：`EXAMPLE_RAW_INPUT`、`EXAMPLE_DRAFT`、`EXAMPLE_DRAFT_JSON` |
| `creative-draft-agent.ts` | `CreativeDraftAgent` 轻量 Agent：一次模型调用 + 结构化输出校验 + 失败重试 |
| `index.ts` | 公共导出 |

测试位于 `src/novel/tests/`（遵循项目「测试按 src 一级模块放 `src/*/tests/`」约定）。

## 使用方式

```ts
import { CreativeDraftAgent, CreativeDraftError } from "./index";
import { ModelClient } from "../../harness/model/contract";

const agent = new CreativeDraftAgent({ model /* ModelClient 实现 */ });
const draft = await agent.createDraft(rawInput); // 返回 CreativeDraft
```

## 边界

- 只做「输入 → 结构化输出」的一次性转换，不维护运行状态；后续建书步骤（书籍配置、故事圣经等）各成模块。
- 需要向用户澄清时，由上层接入人工确认；本模块把疑问写入 `openQuestions`。
- 真实模型调用由应用组装层完成：`src/app/configured-model.ts` 的 `ConfiguredLlmModel` 把 `ModelClient` 契约桥接到项目正式 LLM 机制（`src/config` 解密凭据 + `src/llm` 适配器路由 + `callConfiguredLlm`）。`src/harness/adapters/models/` 仅保留内存演示模型（`MemoryModel`）。
