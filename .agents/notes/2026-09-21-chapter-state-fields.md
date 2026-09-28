# ChapterState 产物字段升级为结构化类型

日期：2026-09-21

## 问题

`ChapterState` 产物字段原为 string 占位（`dispatch?: string` 等），节点契约（上一轮）已可产出
Dispatch / Simulation[] / SceneSheet / RuntimeDelta，但状态机字段还是字符串，二者无法衔接。

## 关键澄清：weavePlan 字段与 SceneSheet 的关系

回读两份文档后确认（推翻"字段名错位"的猜测）：

- 小说级文档 §3.8 的字段名就是 `weavePlan`（非笔误）；§11 目录给出运行时落盘文件清单，
  **`chapter-XXXX.weaveplan.json` 与 `chapter-XXXX.scenesheet.json` 是两个独立文件**。
- 章节级文档 §7.2：WeavePlan 由 **TimelineManager.checkWeaveEligibility(chapter)** 产出（确定性服务，排程方案）；
  §7.4：SceneSheet 由 **Merger.weave** 产出（拍摄单）。二者同属 ③merge 阶段，分别落盘。
- 因此 `weavePlan` 字段的类型就是 **WeavePlan**，SceneSheet 需要**新增字段 `scenesheet`**
  （§3.8 的简写定义漏了它，§11 目录证实其存在）。

## 决定

1. `src/novel/types/chapter-state.ts`：
   - `dispatch?: Dispatch`、`sims?: readonly Simulation[]`、`weavePlan?: WeavePlan`、
     **新增 `scenesheet?: SceneSheet`**、`draft?: string`、`auditReport?: string`、`censorReport?: string`。
   - ⑦settle 的 RuntimeDelta 分解为 hooks.json + facts.json + 状态更新（§11.3），不留存在本章状态中。
2. `src/workflow/types.ts`：新增 `MergeArtifacts { weavePlan: WeavePlan; scenesheet: SceneSheet }`，
   `ChapterStepArtifacts.merge` 由 SceneSheet 改为 `MergeArtifacts`（merge 节点的完整产物是两个），
   `NodeOutput` 联合随之加入 MergeArtifacts。
3. 契约测试同步更新：`_mergeOut` 断言、merge 节点 fixture（含 WeavePlan 排程 + SceneSheet 拍摄单）、全流程断言。

## 影响

- B 写 merge 节点时 output 类型为 `MergeArtifacts`，引擎落盘 artifacts['merge'] 后由持久化层拆分存
  weaveplan.json / scenesheet.json（与文档 §11 目录一致）。
- `ChapterStepArtifacts.merge` 的类型从 SceneSheet 变为 MergeArtifacts 是**契约收紧**：
  WeavePlan 从"不入产物表"修正为 merge 产物的正式一半；上一轮注释已作废。
- 未完成事项：真实 WorkflowStore 落盘实现（按 §11 目录写文件）仍待定；settle 的 hooks.json/facts.json 拆分属 Settler 实现范围。

## 验证

- `npx tsc -p`（novel + workflow + util）零诊断；四份测试 20/20 通过（引擎 11 + 节点契约 2 + §3 模型 2 + 章节运行时 5）。
- 编译期断言：`NodeOutputOf<'merge'>` = MergeArtifacts，且 `merge.weavePlan` 为 WeavePlan、`merge.scenesheet` 为 SceneSheet。
