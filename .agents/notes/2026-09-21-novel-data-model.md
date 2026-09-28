# 定义小说领域共享数据模型（文档 §3）

日期：2026-09-21

## 问题

项目处于地基阶段：LLM 层已就绪、harness 进行中、workflow 与 novel 均未开始。
两份工作流文档（小说级 / 章节级）共用同一套核心数据模型（§3），"定义一次、两文档引用"。
在 B（小说流）与 C（章节流）并行开发前，需要先锁定这份共享契约，避免各自建模产出两套 BookConfig。

## 决定

在 `src/novel/types/` 下落地 §3 全部数据模型，公共入口 `types/index.ts`：

- `identifiers.ts`：品牌标识 BookId / HookId / ThreadId / EventId / FactId / CharacterName（复用 `@fly-novel/util` 的 `Branded`）。
- `book-config.ts`：Platform / Genre / ChapterReviewMode / BookConfig。
- `beat.ts`：Pacing / BeatCharacter / Beat。
- `fact.ts`：SubjectKind / FactStatus / Fact。
- `hook.ts`：HookStatus / HookTiming / HookType / HookRecord，以及状态迁移合法性 `canTransitionHookStatus`（§11.2 六步校验第⑥条的模型化）。
- `thread.ts`：ThreadKind / ThreadStatus / EventStatus / Thread / ThreadEvent。
- `character.ts`：Tier / CharacterRelationship / CharacterCard / CharacterState。
- `chapter-state.ts`：Step / STEP_ORDER / ChapterStatus / ChapterState。

设计约束：**本层只承载数据与纯函数**，不依赖 harness / llm / config，不调 LLM、不访问存储；
字段一律 `readonly`；HookType 采用文档 §3.5 的分类词表（物件/身份/信息差/承诺/威胁/秘密/关系/能力）。
章节级运行时结构（Dispatch / HookContext / WeavePlan / SceneSheet / Simulation / RuntimeDelta）不在本次范围，留待章节流补充。

## 影响

- B（小说流）与 C（章节流）的节点契约签名以本模块为唯一来源；后续新增业务逻辑（建书 / 章节流水线）挂在 `src/novel/` 下扩展。
- `canTransitionHookStatus` 目前把 `deferred` 视为"恢复后才能回收"的旁支；若后续文档明确允许 deferred 直接 resolve，需同步修改该函数与其测试。
- `ChapterState` 产物字段当前用 `string` 占位，结构化类型待章节级运行时结构补充定义。

## 验证

- `pnpm run typecheck`：对比基线，不新增类型诊断（基线含既有 24 处 agent-loop 诊断，本次不处理）。
- `pnpm test`：`src/novel/tests/types.test.ts` 覆盖 STEP_ORDER 顺序/去重、伏笔状态迁移允许与禁止表；编译期断言枚举字面量集合完整。
