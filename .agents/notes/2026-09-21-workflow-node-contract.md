# 节点契约接入章节级运行时结构

日期：2026-09-21

## 问题

骨架阶段 `NodeOutput = unknown`，节点契约无法表达"direct 产出 Dispatch、merge 产出 SceneSheet"；
章节级运行时结构（上一轮交付）已定义但没有入口接入 workflow。

## 决定

在 `src/workflow/types.ts` 上做四件事：

1. **`ChapterStepArtifacts` 产物表**：7 步 → 各自精确产物（direct→Dispatch、simulate→Simulation[]、merge→SceneSheet、
   write/audit/censor→string、settle→RuntimeDelta）。WeavePlan 是 merge 的内部输入（Timeline Manager 产出），不入产物表。
2. **`NodeOutput` 收窄**：`Dispatch | readonly Simulation[] | WeavePlan | SceneSheet | string | RuntimeDelta`。
3. **`StepNode<S, O>` 泛型化**：`O` 默认 `NodeOutputOf<S>`——`StepNode<'direct'>` 的 output 即 Dispatch，`StepNode<'settle'>` 即 RuntimeDelta。
   引擎侧 `StepNode`（S=Step）接受任意类型化节点（协变兼容）。
4. **`artifactOf(ctx, step)`**：按步骤名安全取前序产物，返回 `NodeOutputOf<S> | undefined`；merge 节点写
   `artifactOf(ctx, 'direct')` 直接拿 Dispatch，不再接触 unknown。

`engine.ts` 仅一处类型收紧：运行时工件表 `Record<string, unknown>` → `Record<string, NodeOutput>`，执行语义零改动。

## 影响

- B 写小说流节点时：`const directNode: StepNode<'direct'>` 即可获得精确产物类型，产出即被引擎按步骤名落盘。
- 持久化层（`PersistedWorkflow.artifacts`）按字符串索引，取用时需按产物表断言（见 chapter-contract.test.ts 注释）。
- 未完成事项：`ChapterState` 产物字段仍是 string 占位（衔接 2026-09-21-novel-data-model.md 备注），
  升级为具体类型（含 weavePlan 字段名与 SceneSheet 的对应关系）是下一轮。

## 验证

- `npx tsc -p`（novel + workflow + util）零诊断；四份测试共 20/20 通过：
  engine 11（既有，仅桩函数参数类型收紧）+ chapter-contract 2（类型化节点全流程 + artifactOf 语义）+ §3 模型 2 + 章节运行时 5。
- 编译期断言：`NodeOutputOf<'direct'>` = Dispatch、`<'simulate'>` = Simulation[]、`<'merge'>` = SceneSheet、`<'settle'>` = RuntimeDelta。
- 期间磁盘满导致验证受阻两次，用户手动清理后继续；无任何删除/覆盖用户数据操作。
