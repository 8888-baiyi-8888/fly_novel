# N0 澄清式整理（多轮问答）

日期：2026-09-22

## 需求

用户原始想法 → 草案时，模型产出的 `openQuestions` 此前只是"写进 JSON 的待澄清清单"，没有闭环。目标：用户输入原始想法后，模型先提问（最多 3 轮），回答收集齐后一次性输出完整草案；中途可喊停；不阻塞产出（未决问题仍写回 `openQuestions`）。

## 设计

- **先澄清、后生成**：第一轮模型只输出问题（`{ questions: [...], draft: null }`），问题清空的那一轮输出完整草案——不在交互中反复重算草案，省 token。
- **LLM 无状态，循环由 Agent 驱动**：`CreativeDraftAgent.createDraftWithClarification(rawInput, askUser, options?)` 维护对话历史（模型问题 → 用户回答），每轮把历史拼进消息再调模型；`askUser` 是回调接口，CLI 用 readline 实现，将来可换 GUI。
- **终止条件**（任一满足即收尾）：① 模型给出草案；② 提问满 `maxRounds`（默认 3）轮后强制生成；③ 用户输入停止词（默认 `够了/停止/就这样/不用了`）。
- **健壮性**：模型在提问轮违规同时给出草案时，接受草案并把残留问题并入 `openQuestions`（去重）；每轮输出仍走 JSON 解析 + 协议校验 + 重试（沿用 `maxRetries`）。
- **入口**：`main.ts --model real --clarify` 才进入澄清；不加参数行为与之前完全一致（`createDraft` 原函数零改动，全部为新增）。

## 改动文件

- `src/novel/draft/schema.ts`：新增 `CLARIFY_JSON_DESCRIPTION`（澄清协议描述）。
- `src/novel/draft/validate.ts`：新增 `ClarificationTurn` / `parseClarificationTurn`。
- `src/novel/draft/prompt.ts`：新增 `CLARIFY_SYSTEM_PROMPT` 与澄清消息组装函数。
- `src/novel/draft/creative-draft-agent.ts`：新增 `createDraftWithClarification` / `callClarifyTurn`（原 `createDraft` 不动）。
- `src/app/main.ts`：新增 `--clarify` 分支与 `createCliAsker`（readline 交互）。
- `src/novel/tests/clarify.test.ts`：8 个用例（解析、一轮问清、三轮上限、停止词、违规兜底、空输入、重试失败）。

## 验证

`pnpm run typecheck` 通过；`pnpm test` 全部通过（含新增 8 个澄清用例）。未调用真实模型。
