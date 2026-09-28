# workflow 与 Agent 对接规范

本文档定义章节流工作流与外部 Agent 之间的输入输出契约，供 Agent 实现方（自研/第三方/HTTP 服务）对接使用。
指令原文的唯一事实来源是 `src/workflow/nodes/*.ts` 中的常量；本文档摘录并定位，修改指令后须同步本文。
对接点只有一个：`AgentPort`（`src/workflow/agent-port.ts`）。

## 对接面

```ts
type AgentTask = 'direct' | 'simulate' | 'merge' | 'write' | 'audit' | 'censor' | 'settle'

interface AgentGenerateInput {
  task: AgentTask            // 七个节点任务之一
  instruction: string        // 任务指令（Agent 作为 system 段）
  context: string            // 已序列化的上下文（Agent 作为 user 段）
  outputFormat?: 'text' | 'json'   // 期望 JSON 结构输出时传 'json'
}

interface AgentGenerateOutput {
  text: string               // 生成文本
  json?: unknown             // outputFormat='json' 时解析后的对象（解析失败可不提供，节点回退）
}
```

- 工作流通过 `AgentPort.generate(input)` 调用 Agent，一次调用对应一个节点任务。
- `outputFormat='json'` 的任务，节点会自行尝试 `JSON.parse(text)`；Agent 若直接返回结构化 `json` 则跳过解析。
- 节点内做形状校验：不合法 → `retry` 回本步（预算内自动重跑）或 `fail`。失败原因会带上诊断（如缺失字段清单）。

### 三种对接形态

| 形态 | 说明 | 适配位置 |
|---|---|---|
| C. OpenAI 兼容端点 | `instruction`→system、`context`→user，POST `/chat/completions` | `src/workflow/openai-compatible-agent.ts`（已实现，含流式） |
| B. Agent 为 HTTP 服务 | 自定义协议，`POST /task` 请求/响应即上文接口 | 新增薄适配器实现 `AgentPort` |
| A. Agent 进程内实现 | 直接实现 `AgentPort` 接口注入 | `src/workflow/nodes/index.ts` `buildChapterNodes(agent, deps)` |

## 全局约定（Agent 必须遵守）

1. **严格 JSON**：`json` 任务输出必须是合法 JSON，禁止 Markdown 代码块（```` ```json ```` 等），禁止额外包装键（如 `{"dispatch": …}`、`{"simulations": […]}`）。
2. **枚举来自 context**：`open.type` 的取值（物件/身份/信息差/承诺/威胁/秘密/关系/能力）、`tier`、`op` 等枚举，指令与 context 已给出，Agent 不得自行发明；真实枚举以 `src/novel/types/hook.ts` 的 `HOOK_TYPES` 为准。
3. **hookId 引用现存账本**：除 `open`（新埋，由系统分配）外，`hookId` 必须引用 `context.ledger` 中已存在的伏笔；不存在的一律不操作。
4. **模型参数**：`enable_thinking=false`（思考链会占用输出预算导致 `content` 被截断为空）；`max_tokens` 建议 4096；长生成（write）建议流式。
5. **PASS/FAIL 前缀**：audit / censor 输出必须以 `PASS` 或 `FAIL` 开头（其余文本随后），节点按前缀判定。

## 七张任务卡

指令全文见对应源码常量；此处给出 context 结构、期望输出与校验规则。

### 1. direct（章节导演）

- 指令：`DIRECT_INSTRUCTION`（`src/workflow/nodes/direct.ts`）
- context：`{ chapter, hookContext, ledger, threads }`
  - `hookContext`：`runtime.ledger.viewForChapter(chapter)`（mustResolve/mustAdvance/canResolve/mustNotDefer/pressure 等）
  - `ledger`：账本全量视图（含每条伏笔 status/lastAdvancedChapter/notes）
  - `threads`：`runtime.timeline.snapshotFor(chapter)`（线程与事件快照）
- 期望输出：Dispatch JSON（`src/novel/types/dispatch.ts`）：`{chapter, goal, castPlan[], threadPlan[], hookDirectives:{open[],advance[],resolve[],defer[],mention[]}, styleNotes[], budget{scenes,chars}}`
- 校验：`parseDispatch` 形状校验 + §5.3 闸门（`validateDispatch`）；拒绝 → retry 回 direct。

### 2. simulate（角色模拟）

- 指令：`SIMULATE_INSTRUCTION`（`src/workflow/nodes/simulate.ts`）
- context：Dispatch JSON
- 期望输出：Simulation 数组（`src/novel/types/simulation.ts`）：`[{character, tier:'S'|'A', lines[], actions[], suspects[], reasoning?, risk?}]`
  - 角色必须来自 `dispatch.castPlan`；B 级角色不模拟。
- 校验：`parseSimulations`（至少一条且每条有 `character`）。

### 3. merge（线性拍摄单合成）

- 指令：`MERGE_INSTRUCTION`（`src/workflow/nodes/merge.ts`）
- context：`{ dispatch, sims }`
- 期望输出：SceneSheet JSON（`src/novel/types/scene-sheet.ts`）：`{writingPlan, scenes[{no, kind, pov, slot, purpose, beats[], cast[], material{lines,actions,suspects}, hookOps[], budgetChars, emotion}], weavingNotes, forbidden[]}`
  - 素材只来自 Dispatch/Simulation，不得新增剧情、新伏笔或角色决策；hookOps 无 defer。
- 校验：`parseSceneSheet`。

### 4. write（正文写手）

- 指令：`WRITE_INSTRUCTION` = 文风 5 条（`WRITE_STYLE_GUIDE`）+ 禁令 10 条（`WRITE_BANS`，来源文档 §7.3）（`src/workflow/nodes/write.ts`）
- context：merge 产物（weavePlan + scenesheet）
- 期望输出：纯文本正文（不要 JSON、不要 Markdown 代码块）
- 校验：非空即可；质量问题靠 audit 节点兜底。

### 5. audit（内容审计）

- 指令：`AUDIT_INSTRUCTION`（`src/workflow/nodes/audit.ts`）
- context：`{ draft, dispatch, scenesheet }`（正文 + 拍摄单比对材料）
- 期望输出：`PASS …` 或 `FAIL …`（FAIL 后列出编号条目：问题 + 涉及伏笔/角色）
- 校验：前缀判定；FAIL → retry 回 write 重写。

### 6. censor（内容审查）

- 指令：`CENSOR_INSTRUCTION`（`src/workflow/nodes/censor.ts`）
- context：正文文本
- 期望输出：`PASS …` 或 `FAIL …`（FAIL 后列出条目与修改建议）
- 校验：前缀判定；FAIL → retry 回 write 重写。

### 7. settle（结算器）

- 指令：`SETTLE_INSTRUCTION`（`src/workflow/nodes/settle.ts`）
- context：`{ draft, hookContext, ledger }`
- 期望输出：RuntimeDelta JSON（`src/novel/types/runtime-delta.ts`）：`{facts[], hookOps[{op:'open'|'advance'|'resolve'|'defer'|'mention', …}], stateChanges{角色:{location, goal, emotion, suspects[], inventory[], bonds{}}}}`
  - 判据见指令（§11.1）：resolve=明确解答；advance=新增信息且删掉则离回收更近（仅再提=mention）；open=写得出预期回收；角色"以为"≠叙述层时进 suspects 不进 fact。
- 校验：`parseRuntimeDelta` + §11.3 六步校验（`runtime.settleChapter`）；拒绝 → retry 回 settle（校验摘要进 reason）。

## 联调顺序与验收

1. **先 direct**：跑 `node .test-dist/workflow/run-chapter.js --base-url … --model … --chapter N`，日志出现 `[step] direct 完成（status=planned）` 即通过。
2. **逐节点推进**：simulate → merge → write → audit → censor → settle；每步以"完成"为过，`retry`/`fail` 时把日志 reason 原样反馈给 Agent 方调 prompt。
3. **验收**：一章 `completed` + 账本摘要出现预期变化（如 `H007:resolved`）；连续两章验证跨章账本延续。
4. **失败即信息**：节点挂起/失败的 reason 已带诊断（`describeDispatchFailure` 会列出缺失字段与原始 JSON 预览），优先据此定位。

## 现有实现

- `src/workflow/openai-compatible-agent.ts`：OpenAI 兼容端点适配器（阿里云 MaaS `compatible-mode/v1` 等），含 SSE 流式、`enable_thinking=false`；`run-chapter.ts` 为现成驱动。
- `src/workflow/nodes/stub-agent.ts`：StubAgent（测试/离线运行用，无真实生成）。
- 决策记录：`.agents/notes/`（2026-09-23 起，含 OpenAI 兼容接入、SSE 流式、跨章持久化等）。
