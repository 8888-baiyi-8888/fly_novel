# 2026-09-22：Book Runtime 模拟层 + 第三方 agent 接入（HttpAgent）

## 问题

计划变更：不自己开发 agent，引入第三方 agent（LangChain Deep Agents / Managed Deep Agents，均为 Python 生态），章节流与小说流并行开发。章节流需要在**不依赖小说流交付**的前提下推进，因此需要：①小说流交付的「Book Runtime」的模拟形态；②第三方 agent 的 TS 侧接入占位。

## 决定

1. **BookRuntime 接口**（`src/novel/runtime/book-runtime.ts`）作为章节流与小说流的契约面：`config + ledger + timeline + truth + characters + characterStates + ledgerView + settleChapter(chapter, delta): ApplyDeltaPureResult`。章节流只依赖该接口。
2. **FakeBookRuntime**（`fake-book-runtime.ts`）：`buildFakeBookRuntime(options)` 返回内存实现，缺省取 §7.7 fixture（`fixtures.ts`）。内部三个 InMemory 实现：
   - InMemoryHookLedger：viewForChapter 实时渲染（依赖注入 getter，多章连续运行下每章重新计算）；applyDelta 走 applyDeltaPure；audit/health 抛「属小说级未实现」。
   - InMemoryTimeline：checkWeaveEligibility 占位（active 线按 priority 取 pending 事件）；**canReach 占位规则 = 归属线非 dormant/abandoned 且 syncPoint ≥ chapter-1**（§9.2 闪回线未推进 → 不可 resolve 的最小可测简化）；advanceAll 只推进 active 线。
   - InMemoryTruthOracle：snapshot 按 subject/时效过滤；knowledgeOf 按 knownBy；retcon 占位（旧事实标 retconned + validUntil=本章，新增修正事实）；insertAll 补全 factId（F 序列递增）/validFrom/source/status。
   - **settleChapter**：applyDeltaPure 通过才同批更新账本/真相/时钟/角色状态，rejected 时任何状态不变（§11.3 原子语义）；stateChanges 按角色合并。**§9.2 时点可达闭环（追加）**：结算前用 timeline.canReach 判定 delta 中 resolve 的可达集，注入 applyDeltaPure.resolvableAt（⑤ 拒绝不可达 resolve，warning 非致命，其余操作照常）。
3. **节点接入**：`ChapterNodesDeps = { runtime: BookRuntime }`；direct 实时渲染债务表并接入 §5.3 闸门；settle 产出 RuntimeDelta 后 `runtime.settleChapter`，六步校验拒绝 → retry 回 settle（校验摘要进 reason）。
4. **HttpAgent**（`src/workflow/http-agent.ts`）：`createHttpAgent({ baseUrl, apiKey?, fetchImpl?, timeoutMs? })` 实现 AgentPort——POST `{baseUrl}/generate`，收 `{ text, json }`；非 2xx/超时/坏响应抛错（runAgentTask 转 fail）。第三方原生协议 ↔ 本契约的映射由服务端薄层负责；两条 LangChain 路线（OSS deepagents 自建 / Managed Deep Agents 托管）都能接。
5. 契约修正：TruthOracle.insertAll 参数从 `readonly Fact[]` 改为 `readonly FactDelta[]`（factId 等由事务内补全，这是 §11.3 的正确契约）。

## 影响

- 章节流端到端不再依赖小说流：`StubAgent + FakeBookRuntime` 即可跑通 7 步（含闸门重试、审计重写、断点续跑、settle 回写）；小说流就绪后替换 `BookRuntime` 实现与真实 agent，节点与引擎零改动。
- canReach / advanceAll / retcon / checkWeaveEligibility 为占位语义，真实行为由小说流实现；模拟层只保证形状与可测的确定性。
- viewForChapter 忠实公式下，age 大的 progressing 伏笔同时满足 mustResolve 与 mustAdvance → 合规 Dispatch 需把该类伏笔同时列入 advance 与 resolve（端到端 fixture 已按此修正）。
- retconned 事实不进 TruthSnapshot（active 视图），历史可审计但当前接口不暴露全量查询。
- **§9.2 闭环的时序约束（追加）**：settleChapter 结算前判定可达、结算后推进时钟；canReach 占位因此用 `syncPoint >= chapter-1`（结算前视角：上一章推进到上一章后本章事件已可 resolve；若用 `>= chapter` 会永远滞后一章，ch24 无法 resolve 主线伏笔——跨章测试暴露后修正）。dormant/abandoned 线恒不可达（§9.2 闪回线语义保持）。

## 验证

- `npx tsc -p`（novel+workflow 范围，临时 tsconfig）零诊断；全量基线 25 条诊断仍只在 src/harness/agent-loop/。
- `node --test`：99/99 通过（novel 66 = 原 57 + fake-book-runtime 9；workflow 33 = 原 27 + http-agent 6）；追加跨章演变 4 用例与 §9.2 时点闭环 1 用例后 104/104（novel 71 + workflow 33）。
- 端到端新增断言：settle 后 `runtime.ledgerView` 中 H007 resolved、H011 progressing。
- §9.2 闭环新增用例：同一条 ready 伏笔（H021，ch20 推进到 progressing）——归属 dormant 闪回线时 ch21 resolve 被 ⑤ 拒绝（warning `resolve-unreachable`、状态不变）；归属 active 主线时放行（resolved）。
- 临时文件（tsconfig.check-runtime.json / .test-runtime/）已验证后删除；章节域日常入口为 `tsconfig.chapters.json`。
