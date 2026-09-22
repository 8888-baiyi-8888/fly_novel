# 创意草案整理（novel/draft）

## 职责

对应建书第 1 步：把用户散乱的自然语言想法整理成结构化创意草案（Creation Draft）。

## 内容范围

| 文件 | 说明 |
|---|---|
| `types.ts` | `CreativeDraft` / `ProtagonistDraft` / `SupportingCastDraft` 类型定义（v2：多主角数组 `protagonists`；字段只记录相对稳定属性） |
| `schema.ts` | 结构化输出描述 `DRAFT_JSON_DESCRIPTION`（完整草案）与 `CLARIFY_JSON_DESCRIPTION`（澄清轮 { questions, draft } 包装协议） |
| `validate.ts` | `parseAndValidateDraft` 校验器 + `DraftValidationError`（校验失败抛错；兼容 v1 迁移）；`parseClarificationTurn` 解析澄清轮输出 |
| `prompt.ts` | `buildDraftMessages` 组装系统/用户消息；`buildClarifyMessages` 等组装澄清轮对话历史 |
| `example.ts` | 演示/测试数据：`EXAMPLE_RAW_INPUT`、`EXAMPLE_DRAFT`、`EXAMPLE_DRAFT_JSON` |
| `creative-draft-agent.ts` | `CreativeDraftAgent` 轻量 Agent：一次模型调用 + 结构化输出校验 + 失败重试；`createDraftWithClarification` 多轮澄清（先问后生成，最多 3 轮） |
| `index.ts` | 公共导出 |

测试位于 `src/novel/tests/`（遵循项目「测试按 src 一级模块放 `src/*/tests/`」约定）。

## 澄清式整理（多轮问答）

`createDraftWithClarification(rawInput, askUser, options?)` 实现「先澄清、后生成」：

1. 第一轮模型只输出需要用户回答的问题（`{ questions: [...], draft: null }`）；
2. 调用方（如 CLI）把问题展示给用户，用户回答后拼进对话历史再调模型；
3. 问题清空时模型给出完整草案；最多提问 `maxRounds`（默认 3）轮，或用户输入停止词（默认 `够了/停止/就这样/不用了`）后强制生成；
4. 未决问题自动并入草案 `openQuestions`，不阻塞产出。

`askUser` 是 `(questions: string[]) => Promise<string>` 回调，交互载体由调用方决定（CLI 用 readline，以后可换 GUI）。

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
