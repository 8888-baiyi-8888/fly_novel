# 搭建 workflow 引擎骨架与 stub 测试

日期：2026-09-21

## 问题

章节级流水线（direct → simulate → merge → write → audit → censor → settle）需要编排引擎，
而真实节点执行器（LLM 型节点待 agent-loop 闭环、确定性服务待实现）尚未就绪。
目标是先交付"编排器本身"：顺序、重试回退、预算、断点续跑、挂起通知，用 stub 节点验证。

## 决定

在 `src/workflow/` 下实现章节流水线编排骨架：

- `types.ts`：`StepNode` 节点契约（run(ctx) → StepResult）、`StepOutcome`（continue/retry/suspend/fail）、
  `WorkflowStore` 存储抽象（load/save 断点记录）、`WorkflowEvent` 事件、`ChapterWorkflowResult` 结果。
- `engine.ts`：`ChapterWorkflow` 执行器，按 `STEP_ORDER` 顺序执行；`statusAfterStep` 状态推进；
  `createInitialChapterState` 初始状态。
- `tests/engine.test.ts`：内存存储替身 + stub 节点，覆盖正常路径、重试环、预算耗尽、断点续跑、
  已完结、缺节点、节点失败/挂起、非法回退、状态映射。

关键语义：

- **重试**：节点返回 `retry{step}` 时回退到目标步骤重跑，`retries` 每轮 +1；`retries >= maxRetries`
  后再次失败即挂起（notify + 落盘现场）。只重跑目标步骤及其后步骤，前序步骤不重跑。
- **断点**：每步成功后落盘（state + artifacts）；run 时从 `state.step` 续跑；settled/approved 直接返回 already-complete。
- **状态推进**：每完成一步，status → 该步骤阶段（direct→planned，simulate→simulated，…，settle→settled），
  step → 下一步（settle 为末步，完成后停留）。

## 影响

- 真实节点接入时的执行器骨架已定：节点只需实现 `StepNode` 并注册，引擎不改。
- 挂起时 `step` 停在回退目标（write），续跑会从该步重试；`suspend` 直出时停在当前步骤。
- `direct` 完成后 status 仍为 planned（direct 是规划步骤），此映射为假设，若章节级文档有明确映射需同步修改 `statusAfterStep`。
- 引擎当前面向章节级 `Step`；小说级建书流程需要编排时再泛化步骤类型。

## 验证

- 独立编译 `src/workflow` + 依赖模块，零类型诊断；`tests/engine.test.ts` 全部通过（内存存储 + stub，无外部依赖）。
- 全量 `pnpm run typecheck` 仍仅有既有 24 处 harness/agent-loop 诊断，workflow 无新增。
