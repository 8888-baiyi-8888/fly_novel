# 小说业务（novel）

小说领域数据模型与后续的写作业务逻辑。

## 一级子目录

- [types/](types/index.ts)：**小说领域共享数据模型**（工作流文档 §3 核心数据模型 + 章节级运行时结构）。
  §3：BookConfig / Beat / Fact / HookRecord / Thread / CharacterCard / ChapterState，
  以及配套的品牌标识（BookId/HookId/ThreadId/EventId/FactId/CharacterName）与
  伏笔状态迁移合法性判定 `canTransitionHookStatus`。
  ChapterState 产物字段已收敛为结构化类型：dispatch / sims / weavePlan / scenesheet / draft / auditReport / censorReport
  （weavePlan 与 scenesheet 为 ③merge 的两个独立产物，对应 weaveplan.json / scenesheet.json）。
  章节级运行时结构（章节级文档定义，本章节流节点间的数据契约）：
  Dispatch / HookDirectives / HookContext / Simulation / WeavePlan / SceneSheet / RuntimeDelta。
  定义一次、小说级与章节级工作流共同引用；**本模块不依赖 harness / llm / config，可独立编译与测试**。
- [gates/](gates/dispatch-gate.ts)：**确定性校验闸门**（纯函数，先于落盘执行）。
  已实现 §5.3 Dispatch 校验闸门 `validateDispatch`（七条硬规则、聚合不短路），
  输出 `DispatchGateVerdict`（passed / violations），供 ①direct 节点产出 Dispatch 后立即校验。
  [apply-delta-gate.ts](gates/apply-delta-gate.ts)：**§11.2 六步校验链（①-⑤）** `validateApplyDelta`——
  ①schema（手写形状校验替代 Zod）/ ②ID（拒绝整批）/ ③readyToResolve 降级为 advance /
  ④dependsOn 前置 / ⑤时间线可达（resolvableAt 注入），输出 `ApplyDeltaVerdict`（accepted / rejected-batch）。
- [services/](services/index.ts)：**确定性服务**（章节级文档 §16.1 组件接口，纯函数先行）。
  已实现 HookLedger 核心纯函数：`lifecycle`（§4.3 压力算法 + §4.2 档位表）、
  `admitHookCandidate`（§10.4 准入两条硬规则）、`mergeHookOps`（§11.2 ⑥ 不可变合并）、
  `viewForChapter`（§4.4 债务表：mustResolve/mustAdvance/canResolve/canAdvance/mustNotDefer/
  pressure/staleDebt/budget，①direct 的只读输入，与 §5.3 闸门闭环）、
  `applyDeltaPure`（apply-delta.ts，六步校验①-⑤ + ⑥合并的编排入口，存储层接入前最后一环）。
  TimelineManager / TruthOracle 已落地接口契约（含 canReach / knowledgeOf / insertAll 签名），行为由 runtime 模拟层提供。
- [runtime/](runtime/index.ts)：**Book Runtime 模拟层**（小说流交付给章节流的确定性状态面）。
  `BookRuntime` 接口 = BookConfig + HookLedger + TimelineManager + TruthOracle + 角色卡/状态 + `settleChapter`；
  `buildFakeBookRuntime` 内存实现（viewForChapter 实时渲染、settleChapter 走 §11.3 原子语义：
  六步校验通过才同批更新账本/真相/时钟/角色状态，拒绝时任何状态不变），
  fixtures 提供 §7.7 全量实例（H007/H011/H014/H021/H023、主线/闪回线、F001、四张角色卡）。
  章节流不依赖小说流即可端到端运行；小说流就绪后以真实服务实现替换，节点与引擎零改动。
  settleChapter 已接 §9.2 时点可达闭环：结算前用 timeline.canReach 判定 resolve 可达集注入
  applyDeltaPure.resolvableAt（⑤ 拒绝不可达 resolve，warning 非致命）。
  canReach / advanceAll / retcon / checkWeaveEligibility 为最小可测占位规则（注释标注）。
- [tests/](tests/types.test.ts)：数据模型常量与状态迁移测试，随 typecheck 一并做枚举集合完整性编译期断言。
  [chapter-runtime.test.ts](tests/chapter-runtime.test.ts)：运行时结构 fixture 测试（基于文档 §7.7 实例）。
  [dispatch-gate.test.ts](tests/dispatch-gate.test.ts)：§5.3 七条规则逐条 + 边界 + 多违规聚合（10 用例）。
  [hook-ledger.test.ts](tests/hook-ledger.test.ts)：§4.3 lifecycle / §10.4 准入 / §11.2 ⑥ 合并（15 用例）。
  [apply-delta-gate.test.ts](tests/apply-delta-gate.test.ts)：六步校验①-⑤ 逐条 + 多违规 + 链路（8 用例）。
  [apply-delta.test.ts](tests/apply-delta.test.ts)：applyDeltaPure 编排入口——通过/整批拒绝/降级/依赖/可达/混合批 + 不可变（7 用例）。
  [view-for-chapter.test.ts](tests/view-for-chapter.test.ts)：§4.4 债务表渲染——四类指令/压力标签/预算/挂起与结清排除（10 用例）。
  [fake-book-runtime.test.ts](tests/fake-book-runtime.test.ts)：BookRuntime 模拟层——viewForChapter 实时渲染/
  canReach 时点可达/knownBy 信息差/settle 原子回写/幂等/retcon（9 用例）。
  [multi-chapter-evolution.test.ts](tests/multi-chapter-evolution.test.ts)：跨章连续 settle（同一 runtime 4 章）——
  账本演变（resolve 结清/降级推进/自动编号/deferred 挂起）、真相累积与信息差、时钟推进与 canReach 翻转、
  §9.2 时点可达闭环（同一条 ready 伏笔：线未推进 → ⑤ 拒绝；推进 → 放行）、不可变与 rejected 原子性（5 用例）。

## 设计约束

- 本层只承载**数据与纯函数**：不带 I/O、不调 LLM、不访问存储。
  确定性服务（Hook Ledger / TruthOracle / Timeline Manager）在业务层实现时依赖这些类型。
- 章节级运行时结构（Dispatch / HookContext / WeavePlan / SceneSheet / Simulation / RuntimeDelta）
  由章节级文档定义，后续按章节流需求在本模块内补充。
