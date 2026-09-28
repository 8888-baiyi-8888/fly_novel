# 工作流引擎（workflow）

步骤流水线编排与执行。当前实现**章节级 7 步流水线**（direct → simulate → merge → write → audit → censor → settle）。

## 能力

- **节点契约**（[types.ts](types.ts)）：`StepNode<S, O>` 给定执行上下文，返回 `StepResult`（结果 + 可选产物）。产物类型直接引用章节级运行时结构：
  - `NodeOutput` 收敛为 `Dispatch | Simulation[] | WeavePlan | SceneSheet | string | RuntimeDelta`；
  - 产物表 `ChapterStepArtifacts` 把 7 步映射到各自精确产物（direct→Dispatch，simulate→Simulation[]，merge→{weavePlan, scenesheet}，write/audit/censor→string，settle→RuntimeDelta），`StepNode<'direct'>` 的 output 即 `Dispatch`；
  - `artifactOf(ctx, step)` 按步骤名安全取前序产物（未产出返回 undefined），节点内不再接触 `unknown`。
  - **direct 闸门契约**（[direct-gate.ts](direct-gate.ts)）：`withDispatchGate(node, judge)` 把 §5.3 Dispatch 校验闸门接到 direct 节点产物上——产出 Dispatch 后必须通过 `validateDispatch`，未通过 → 返回 `retry` 回 direct（reason 附违规摘要），由引擎重试预算决定重跑或挂起；节点自带的 suspend/fail/无产物结果原样透传。
- **agent 端口**（[agent-port.ts](agent-port.ts)）：`AgentPort.generate` 是 workflow 消费的 agent 生成能力契约（task/instruction/context → text 或 JSON）。**预留真实 agent 的位置**：自研 agent-loop 或第三方 agent（经进程外服务）实现同一端口注入即可，引擎与节点零改动。
- **HttpAgent**（[http-agent.ts](http-agent.ts)）：`AgentPort` 的进程外 HTTP 适配器（第三方 agent 接入面）——POST `{baseUrl}/generate` 收 `{ text, json }`，非 2xx / 超时 / 坏响应转抛错（节点经 `runAgentTask` 转 fail）。服务端薄层负责把第三方原生协议（如 LangChain Deep Agents / Managed Deep Agents）映射到本契约。
- **OpenAICompatibleAgent**（[openai-compatible-agent.ts](openai-compatible-agent.ts)）：`AgentPort` 的 OpenAI 兼容协议适配器（阿里云 MaaS `compatible-mode/v1`、DashScope、DeepSeek 等 `/chat/completions` 端点）——`instruction→system`、`context→user`、`outputFormat=json` 且 `jsonMode=true` 时请求 `response_format=json_object`，取 `choices[0].message.content` 为 text 并顺带解析 json；非 2xx / 超时 / 缺 content 转抛错。
- **StubAgent**（[stub-agent.ts](stub-agent.ts)）：确定性模拟 agent——按规则表返回预设响应，支持调用次数轮换（重试场景：先违规后合规）、instruction 子串分支、调用计数。当前用它驱动 workflow 端到端先行开发。
- **JsonFileStore**（[file-store.ts](file-store.ts)）：`WorkflowStore` 的 JSON 文件实现（断点续跑落地）——布局 `{dir}/{bookId}/{chapter}.json`，写 `{chapter}.json.tmp` 再 rename（原子替换），load 遇 ENOENT 返回 undefined。真实存储（§11.3 单事务）就绪后替换，引擎零改动。
- **参考节点**（[nodes/](nodes/index.ts)）：`buildChapterNodes(agent, { runtime })` 组装 7 步可运行节点——LLM 型节点（direct/simulate/merge/write/audit/censor/settle）经 AgentPort 生成并做产物形状校验，direct 实时渲染债务表（`runtime.ledger.viewForChapter`）并接入 §5.3 闸门，merge 的 weavePlan 用确定性占位（`minimalWeavePlan`，TimelineManager 位置），audit/censor 以 PASS/FAIL 前缀做最小判定（回 write 重写），**settle 产出 RuntimeDelta 后回写 BookRuntime**（`runtime.settleChapter`，§11.3 原子语义：六步校验拒绝 → retry 回 settle 附违规摘要）。**指令与判定均为占位**，真实策略由 B 按文档替换对应工厂。
- **执行器**（[engine.ts](engine.ts)）：`ChapterWorkflow` 按 `STEP_ORDER` 顺序执行，支持：
  - **重试回退**：节点返回 `retry` 时回退到目标步骤重跑（闸门拒绝→回 direct；audit/censor 不过→回 write），每章重试预算 `maxRetries` 封顶，超预算挂起等待人类；
  - **断点续跑**：经 `WorkflowStore` 持久化状态与工件，从 `ChapterState.step` 继续，不重跑前序；
  - **挂起/失败通知**：`notify` 回调 + 现场落盘。
- **状态推进**：每完成一步，status 推进到该步骤对应阶段（direct→planned，simulate→simulated，…，settle→settled），step 指向下一步；settle 完成后章节即 settled。

## 一级子目录

- [types.ts](types.ts)：节点、结果、存储（WorkflowStore）、事件与运行结果契约。
- [agent-port.ts](agent-port.ts)：agent 生成能力端口 `AgentPort`（真实 agent 的接入面）。
- [http-agent.ts](http-agent.ts)：`AgentPort` 的进程外 HTTP 适配器（第三方 agent 接入面，自定 `/generate` 协议）。
- [openai-compatible-agent.ts](openai-compatible-agent.ts)：`AgentPort` 的 OpenAI 兼容协议适配器（阿里云 MaaS / DashScope / DeepSeek 等）。
- [stub-agent.ts](stub-agent.ts)：确定性模拟 agent（规则表 + 轮换 + 计数）。
- [file-store.ts](file-store.ts)：`WorkflowStore` 的 JSON 文件实现（断点续跑落地）。
- 章节级驱动入口已上移到 **`src/app/run-chapters.ts`**（与小说级 main.ts 同层）：自动定位最新 N7 书目录（`artifacts/n7-workspace/<bookId>/`）、复用小说级 model 配置（`ConfiguredLlmModel`，从 settings + 解密凭据读取，不传参数/env）、支持 `--chapter/--to` 连续写章；每章正文导 `{store-dir}/{bookId}/{chapter}.md`，运行时状态（账本/真相/时钟/角色状态）落 `{store-dir}/{bookId}/runtime-state.json`，下次运行自动恢复——**跨章账本由此延续**。原 `run-chapter.ts`（手动传 `--base-url/--model/--api-key` 与环境变量 `FLY_NOVEL_*` 的调试入口）已删除，由该入口替代。
- [direct-gate.ts](direct-gate.ts)：direct 节点闸门包装器 `withDispatchGate`（§5.3 校验接入点）。
- [nodes/](nodes/index.ts)：章节流 7 节点参考实现（`buildChapterNodes(agent, { runtime })` 组装，各节点可单独替换）。
- [engine.ts](engine.ts)：章节流水线执行器与状态推进。
- [tests/](tests/engine.test.ts)：stub 节点测试——正常路径、审计重试环、预算耗尽挂起、断点续跑、已完结、缺节点、节点失败/挂起、非法回退、状态映射。
  [chapter-contract.test.ts](tests/chapter-contract.test.ts)：类型化节点测试——`StepNode<'direct'>` 产 Dispatch、merge 经 `artifactOf` 取前序、settle 产 RuntimeDelta 的完整 7 步流程。
  [direct-gate.test.ts](tests/direct-gate.test.ts)：闸门接线测试——合规通过/违规 retry/非 continue 透传/引擎集成（预算耗尽挂起）。
  [stub-agent.test.ts](tests/stub-agent.test.ts)：StubAgent 行为测试——json/text 响应、轮换、match 分支、无匹配抛错、计数。
  [http-agent.test.ts](tests/http-agent.test.ts)：HttpAgent 适配器测试——json/text 响应、apiKey 头、非 2xx/坏响应/超时转抛错。
  [openai-compatible-agent.test.ts](tests/openai-compatible-agent.test.ts)：OpenAI 兼容适配器测试——system/user 映射、response_format、json 解析、jsonMode=false 兜底、temperature 透传、非 2xx/缺 content/超时转抛错。
  [file-store.test.ts](tests/file-store.test.ts)：JsonFileStore 测试——save/load 回读、不存在章返回 undefined、重复 save 覆盖、目录自动创建与多 bookId 分目录。
  [end-to-end.test.ts](tests/end-to-end.test.ts)：StubAgent + FakeBookRuntime 驱动的端到端测试——7 步全流程产物齐全、settle 回写 BookRuntime、闸门 retry 闭环、审计重写环、settle 失败后断点续跑不重跑前序。
  [write.test.ts](tests/write.test.ts)：write 节点指令断言——§7.3 十条禁令全部在指令内（`WRITE_BANS` 计数=10）、context 含拍摄单。

## 当前状态与边界

- **端到端已可运行**：注入 `StubAgent` + `FakeBookRuntime`（`buildFakeBookRuntime`，§7.7 fixture）即可跑通 7 步（含闸门重试、审计重写、断点续跑、settle 回写）；**真实 agent 已可接入**：阿里云 MaaS（`compatible-mode/v1`，OpenAI 兼容）等端点经 `createOpenAICompatibleAgent` 直连，LangChain Deep Agents 等自定协议走 `createHttpAgent` + 服务端薄层。
- **跨章运行时状态**：`FakeBookRuntime` 提供 `snapshot()/restore()`（`fake-book-runtime.ts`，账本/真相/时钟/角色状态；plain JSON 可序列化）；`run-chapters` 每次运行前恢复、结束后落盘 `{store-dir}/{book}/runtime-state.json`——连续跑章时世界真实延续（H007 的推进不会因进程重启而丢失）。
- 参考节点的指令文本与 audit/censor 判定规则为**占位**，业务正确性由 B 的节点实现负责；merge 的 weavePlan 暂用 `minimalWeavePlan` 占位（TimelineManager 真实排程待小说流）。
- `WorkflowStore` 已提供 JSON 文件实现（`createJsonFileStore`，断点续跑落地）；§11.3 单事务原子落盘（facts/账本/正文同库）仍待真实存储接入——settle 的原子语义目前由 `BookRuntime.settleChapter` 在内存内保证（拒绝时任何状态不变）。
- 引擎当前面向章节级 `Step`；小说级建书流程需要编排时，再按需泛化步骤类型。
- 假设（记录于 `.agents/notes/2026-09-21-workflow-engine.md`）：`direct` 完成后 status 仍为 planned（规划步骤）；预算耗尽挂起时 step 停在回退目标步骤。
- 第三方 agent 接入：OpenAI 兼容路线已落地（阿里云 MaaS 实配）；LangChain 原生协议映射与结构化输出保障（RuntimeDelta/Dispatch 的 JSON 形状，必要时加修复层）待实际对接时确认（见 `.agents/notes/2026-09-22-book-runtime-http-agent.md`、`.agents/notes/2026-09-23-openai-compatible-file-store.md`）。
