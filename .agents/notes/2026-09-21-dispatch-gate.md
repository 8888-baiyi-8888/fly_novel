# Dispatch 校验闸门（§5.3）落成确定性纯函数

日期：2026-09-21

## 问题

①direct 节点产出 Dispatch 后，必须先行校验再入库。文档 §5.3 给出七条硬规则，
但项目里还没有任何执行它的代码；B 的 direct 节点无法直接引用一个不存在的闸门。

## 决定

1. 新增 `src/novel/gates/dispatch-gate.ts`，导出：
   - `validateDispatch({ dispatch, context, ledger }): DispatchGateVerdict`——纯函数，聚合不短路，
     返回 `{ passed: true }` 或 `{ passed: false, violations }`。
   - `DispatchGateLedgerEntry = Pick<HookRecord, 'status'|'startChapter'|'lastAdvancedChapter'|'coreHook'>`：
     校验所需的最小账本视图；真实账本（HookRecord 全集）可整体传入（结构协变兼容）。
   - `DispatchGateRule`（七条规则标识）与 `DispatchViolation { rule, message, hookIds? }`。
2. 七条规则全部按文档 §5.3 原文语义实现；**规则 5 语义偏差（标注）**：
   文档原文「open 数 < resolve 数」是**约束断言**（违反→拒绝），但严格按 `<` 会误拒
   「开一还一」（1<1 为假）与无伏笔操作的章节（0<0 为假）。实现按
   **「开新不得多于还旧（open.length ≤ resolve.length）」**，即 `open > resolve` 才违规。
   已在代码注释与测试（"开一还一不触发"）双重固定。
3. 测试 `src/novel/tests/dispatch-gate.test.ts`：10 用例 = 通过 + 规则 1-7 各一 +
   规则 4 边界（已埋设/非 open 不触发）+ 多违规聚合（同时违反 4 条时 violations 完整列出）。
   fixture 基于文档 §7.7 第 21 章实例（H007 回收、H011 推进）。

## 影响

- B 写 direct 节点时，在产出 Dispatch 后调用 `validateDispatch`，`passed=false` 即拒绝入库并携带全部违规供重生成。
- `gates/` 成为 novel 层确定性校验的固定目录：后续 §9.6「六步校验」、Settle 前校验等同型纯函数落此处。
- 闸门不触碰存储/LLM，属于「确定性服务」纯函数线，可由 C（章节流）先行实现，不依赖 harness。

## 验证

- `npx tsc -p`（novel + util）零诊断；novel 全部测试 17/17 通过（闸门 10 + §3 模型 2 + 章节运行时 5）。
- 每规则用例断言 `violations[0].rule` 精确命中目标规则且 `violations.length === 1`（隔离性），
  多违规用例断言 4 条规则齐全（聚合性）。
- 修复记录：初版 5 个失败均为 fixture 未做到「只违反目标规则」（改写 resolve 后先触发 must-resolve-not-covered），
  调整为每用例显式对齐 context 强制项后全绿。
