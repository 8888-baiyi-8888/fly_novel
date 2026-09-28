# 定义章节级运行时结构契约类型

日期：2026-09-21

## 问题

章节级流水线节点之间流动的数据（Dispatch / HookContext / WeavePlan / SceneSheet / Simulation / RuntimeDelta）
在章节级文档中定义，但此前只有 §3 共享模型（novel/types）落地。节点契约签名需要这些运行时结构作为输入输出类型。

## 决定

在 `src/novel/types/` 下新增 6 个文件，公共入口 `types/index.ts` 汇总导出：

- `dispatch.ts`：Dispatch / CastPlanEntry / ThreadPlanEntry / DispatchBudget（§5.2 原文）。
- `hook-context.ts`：HookDirectives / HookOpenDirective / HookContext / HookPressure / HookBudget（§4.4 原文）。
- `simulation.ts`：Simulation——文档无 interface，按 §6.3 S 级回答四段（怎么做/为什么/怀疑/风险）
  与 §7.4 SceneSheet.material（lines/actions/suspects）**推导**。
- `weave-plan.ts`：WeavePlan / WeaveSideInsert / WeaveBlocked（§7.2 原文；sideInserts.slot 无 middle）。
- `scene-sheet.ts`：SceneSheet / SceneSheetScene / SceneHookOp / SceneMaterial（§7.4 原文；hookOps 无 defer）。
- `runtime-delta.ts`：RuntimeDelta / HookOp / FactDelta / CharacterStateChange——文档无 interface，
  按 §11.1 三类 delta（facts / hookOps / stateChanges）与 §11.2 六步校验合并规则**推导**。

约束与约定：

- 全部字段 `readonly`；跨模块 ID 用品牌类型（HookId / ThreadId / EventId / CharacterName），与 §3 一致。
- 文档标注 `string[]` 的 eventId 列表（WeavePlan.mainEvents 等）收敛为 EventId[]。
- SceneHookOp 场景内无 defer（§7.4），挂起决策只发生在 Director 层；RuntimeDelta.HookOp 为 settle 全量五类。
- FactDelta 不含 factId/validFromChapter/sourceChapter——由 TruthOracle 在事务内补全（§11.3）。
- CharacterStateChange 限定 location/goal/emotion/suspects/inventory/bonds；knowns 由 TruthOracle 派生，不直接写入。

## 影响

- 章节流节点契约签名（StepNode 输出）可以直接引用这些结构；workflow 引擎保持通用，不依赖具体结构。
- Simulation / RuntimeDelta 为推导结构：若章节级文档后续给出明确 interface，需同步修改并更新测试。
- Dispatch / SceneSheet 同时被小说流终审、审计复用，故放在共享 novel/types 而非 workflow。

## 验证

- 独立编译 src/novel（含 util），零类型诊断；`tests/chapter-runtime.test.ts` 基于文档 §7.7 第 21 章实例构造
  Dispatch / HookContext / Simulation / SceneSheet / RuntimeDelta fixture，类型 + 值双重校验，全部通过。
- 编译期断言：HookOp 五类 op、SceneHookOp 四类 op 穷尽，SideInsertSlot 无 middle。
