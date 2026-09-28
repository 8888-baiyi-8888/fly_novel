# validateDispatch 接入 workflow direct 节点契约

日期：2026-09-21

## 问题

§5.3 Dispatch 校验闸门已落成纯函数（`src/novel/gates/dispatch-gate.ts`），但只停留在
"可以调用"层面；B 写 direct 节点时没有契约上的强制接入点，闸门可能被绕过或接线方式不统一。

## 决定

1. 新增 `src/workflow/direct-gate.ts`，导出 `withDispatchGate(node, judge): StepNode<'direct'>`：
   - 包装器执行原节点后，仅对 `continue` 且有产物的结果做闸门判定（`judge(output, ctx) → DispatchGateVerdict`）；
   - `passed=true` → 原样放行；`passed=false` → 返回 `retry` 回 direct，reason 附违规摘要
     （`[rule] message` 拼接），交由引擎既有重试预算决定重跑或挂起；
   - 节点自带的 suspend / fail / 无产物结果**原样透传**，不误触发闸门。
2. **不改动** `ChapterStepArtifacts` / `NodeOutput` / `StepNode` 形状：direct 产物仍是 `Dispatch`，
   闸门作为"节点实现的外层强制契约"，而非类型字段——避免把校验结论冗余进产物表。
3. `judge` 由调用方注入（真实场景：`validateDispatch({ dispatch, context: viewForChapter(chapter), ledger })`），
   包装器不感知 HookContext/账本来源，保持 workflow 与确定性服务的解耦。

## 影响

- B 写 direct 节点时统一 `withDispatchGate(directNodeImpl, judge)` 接入；闸门拒绝即触发
  引擎重试/挂起闭环，无需 direct 节点内部自行处理校验失败。
- 契约测试（4 用例）覆盖：合规通过（产物原样）、违规 retry（reason 含规则标识）、
  非 continue 透传、引擎集成（maxRetries=2 时 retrying×2 → suspended）。
- 边界：闸门输入所需的 HookContext / ledger 仍依赖 HookLedger 确定性服务（未实现），
  接线时由节点实现方闭包提供；engine 不新增任何业务依赖。

## 验证

- `npx tsc -p`（novel + workflow + util）零诊断；全部测试 34/34 通过
  （novel 17 = 闸门 10 + §3 模型 2 + 章节运行时 5；workflow 17 = 引擎 11 + 节点契约 2 + 闸门接线 4）。
- 编译期断言：`withDispatchGate` 返回值仍为 `StepNode<'direct'>`。
