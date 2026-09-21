# 创意草案整理（novel/draft）

## 职责

对应建书第 1 步：把用户散乱的自然语言想法整理成结构化创意草案（Creation Draft）。

## 内容范围

| 文件 | 说明 |
|---|---|
| `types.ts` | `CreativeDraft` / `ProtagonistDraft` 类型定义（字段只记录相对稳定属性） |
| `schema.ts` | 结构化输出描述 `DRAFT_JSON_DESCRIPTION`（供提示词与模型契约使用） |
| `validate.ts` | `parseAndValidateDraft` 校验器 + `DraftValidationError`（校验失败抛错） |
| `prompt.ts` | `buildDraftMessages` 组装系统/用户消息 |
| `example.ts` | 演示/测试数据：`EXAMPLE_RAW_INPUT`、`EXAMPLE_DRAFT`、`EXAMPLE_DRAFT_JSON` |
| `creative-draft-agent.ts` | `CreativeDraftAgent` 轻量 Agent：一次模型调用 + 结构化输出校验 + 失败重试 |

## 使用方式

```ts
import { CreativeDraftAgent, CreativeDraftError } from "./index";
import { ModelClient } from "../../harness/model/contract";

const agent = new CreativeDraftAgent({ model /* ModelClient 实现 */ });
const draft = await agent.createDraft(rawInput); // 返回 CreativeDraft
```

## 边界

- 只做「输入 → 结构化输出」的一次性转换，不维护运行状态；后续建书步骤（书籍配置、故事圣经等）各成模块。
- 需要向用户澄清时，由上层接入人工确认（harness/approval）；本模块把疑问写入 `openQuestions`。
- 真实模型供应商接入在 `harness/adapters/models/`，本模块只依赖 `ModelClient` 接口。
