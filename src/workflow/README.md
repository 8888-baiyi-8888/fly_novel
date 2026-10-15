# 工作流引擎（workflow）

工作流编排与执行。章节级流程使用 LangGraph 状态图，小说级建书流程也使用 LangGraph；章节节点工厂继续提供各步骤的业务行为。

## 小说级建书图

[novel_workflow/](novel_workflow/index.ts) 导出 `buildNovelGraph` 与唯一状态定义 `NovelWorkflowSchema`。调用方提供六个 Agent 实例和产物根目录；图从 `normalized_input` 开始，草案节点同时生成书籍配置，随后并行执行故事基础设定与长期控制，两路完成后汇合生成静态架构，最后生成初始状态、书目录和交接凭据。`persist: true` 时各节点写入 `{artifactRoot}/{novelId}/{nodeName}/`，工作空间在 `workspace_node/`，`ready_node/` 存交接记录，工作空间内仍有 `story/runtime/ready.json`；`persist: false` 时只生成内存预览。`single-step.ts` 只从指定小说 ID 的目录恢复前序产物。旧版全局 `n0-raw-input` 至 `n6-state0` 目录保留，但新入口不自动迁移或读取。模型配置与终端交互由[应用入口](../app/novel-workflow/workflow.ts)提供。

应用入口未传 `--novel-id` 时，在草案确定书名后按时间戳、书名拼音和递增序号生成 ID，并将整理输入与草案保存到该 ID 目录；`ni` 单步使用时间戳和目录冲突序号，因为该节点不生成书名。N7 书目录以 `characters/<characterId>.json` 保存单角色卡，并生成 `characters/index.json` 与 `characters/all.json`；章节流从汇总文件读取角色卡。

`draft` 节点按小说 ID 读取最新草案产物；已有草案时直接复用并跳过 Agent 调用，缺少草案时才生成。该节点同时从草案生成书籍配置，不在图中另设 `book_config` 节点。已有书籍配置随草案复用；缺少时重新生成。两份产物仍分别保存在 `draft_node/` 和 `book_config/`，读取与 `persist` 设置无关。

## 能力

- **节点契约**（[types.ts](types.ts)）：`StepNode<S, O>` 给定执行上下文，返回 `StepResult`（结果 + 可选产物）。产物类型直接引用章节级运行时结构：
  - `NodeOutput` 收敛为 `Dispatch | Simulation[] | WeavePlan | SceneSheet | string | RuntimeDelta`；
  - 产物表 `ChapterStepArtifacts` 把 7 步映射到各自精确产物（direct→Dispatch，simulate→Simulation[]，merge→{weavePlan, scenesheet}，write/audit/censor→string，settle→RuntimeDelta），`StepNode<'direct'>` 的 output 即 `Dispatch`；
  - `artifactOf(ctx, step)` 按步骤名安全取前序产物（未产出返回 undefined），节点内不再接触 `unknown`。
  - **direct 闸门契约**（[direct-gate.ts](direct-gate.ts)）：`withDispatchGate(node, judge)` 把 §5.3 Dispatch 校验闸门接到 direct 节点产物上——产出 Dispatch 后必须通过 `validateDispatch`，未通过 → 返回 `retry` 回 direct（reason 附违规摘要），由 transition 节点根据重试预算决定重跑或挂起；节点自带的 suspend/fail/无产物结果原样透传。
- **agent 端口**（[agent-port.ts](agent-port.ts)）：`AgentPort.generate` 是 workflow 消费的 agent 生成能力契约（task/instruction/context → text 或 JSON）。**预留真实 agent 的位置**：自研 agent-loop 或第三方 agent（经进程外服务）实现同一端口注入即可，引擎与节点零改动。
- **HttpAgent**（[http-agent.ts](http-agent.ts)）：`AgentPort` 的进程外 HTTP 适配器（第三方 agent 接入面）——POST `{baseUrl}/generate` 收 `{ text, json }`，非 2xx / 超时 / 坏响应转抛错（节点经 `runAgentTask` 转 fail）。服务端薄层负责把第三方原生协议（如 LangChain Deep Agents / Managed Deep Agents）映射到本契约。
- **OpenAICompatibleAgent**（[openai-compatible-agent.ts](openai-compatible-agent.ts)）：`AgentPort` 的 OpenAI 兼容协议适配器（阿里云 MaaS `compatible-mode/v1`、DashScope、DeepSeek 等 `/chat/completions` 端点）——`instruction→system`、`context→user`、`outputFormat=json` 且 `jsonMode=true` 时请求 `response_format=json_object`，取 `choices[0].message.content` 为 text 并顺带解析 json；非 2xx / 超时 / 缺 content 转抛错。
- **StubAgent**（[stub-agent.ts](stub-agent.ts)）：确定性模拟 agent——按规则表返回预设响应，支持调用次数轮换（重试场景：先违规后合规）、instruction 子串分支、调用计数。当前用它驱动 workflow 端到端先行开发。
- **JsonFileStore**（[file-store.ts](file-store.ts)）：`WorkflowStore` 的 JSON 文件实现（断点续跑落地）——布局 `{dir}/{chapter}.json`，写 `{chapter}.json.tmp` 再 rename（原子替换），load 遇 ENOENT 返回 undefined。真实存储（§11.3 单事务）就绪后替换，引擎零改动。
- **章节图**（[chapter_workflow/](chapter_workflow/index.ts)）：`buildChapterGraph` 将现有 7 个章节节点接入 LangGraph。图状态保存章节状态和 `artifacts`，条件边按当前 `step` 前进或按节点 outcome 回退；重试预算耗尽时挂起。`runChapterGraph` 从 `WorkflowStore` 恢复并在每次转移后保存，断点文件以章节号命名，路径按小说 ID 隔离。
  - **重试回退**：节点返回 `retry` 时回退到目标步骤重跑（闸门拒绝→回 direct；audit/censor 不过→回 write），每章重试预算 `maxRetries` 封顶，超预算挂起等待人类；
  - **断点续跑**：经 `WorkflowStore` 持久化状态与工件，从 `ChapterState.step` 继续，不重跑前序；
  - **挂起/失败通知**：`notify` 回调 + 现场落盘。
- **状态推进**：每完成一步，status 推进到该步骤对应阶段（direct→planned，simulate→simulated，…，settle→settled），step 指向下一步；settle 完成后章节即 settled。

## 一级子目录

- [chapter_workflow/](chapter_workflow/index.ts)：章节级 LangGraph 状态定义、七个章节业务节点、图构建与断点恢复入口。
- [novel_workflow/](novel_workflow/index.ts)：小说级 LangGraph 状态定义、建图函数、节点与产物读写。
- [types.ts](types.ts)：节点、结果、存储（WorkflowStore）、事件与运行结果契约。
- [agent-port.ts](agent-port.ts)：agent 生成能力端口 `AgentPort`（真实 agent 的接入面）。
- [http-agent.ts](http-agent.ts)：`AgentPort` 的进程外 HTTP 适配器（第三方 agent 接入面，自定 `/generate` 协议）。
- [openai-compatible-agent.ts](openai-compatible-agent.ts)：`AgentPort` 的 OpenAI 兼容协议适配器（阿里云 MaaS / DashScope / DeepSeek 等）。
- [stub-agent.ts](stub-agent.ts)：确定性模拟 agent（规则表 + 轮换 + 计数）。
- [file-store.ts](file-store.ts)：`WorkflowStore` 的 JSON 文件实现（断点续跑落地）。
- 章节级驱动入口在 **`src/app/run-chapters.ts`**：自动定位最新小说书目录（`{artifactRoot}/{novelId}/workspace_node/`），也可传 `--novel-id`；通过 `src/app/chat-openai-model.ts` 读取小说级模型配置与凭据，支持 `--chapter/--to` 连续写章。正文、断点和运行时状态写入 `{store-dir}/{novelId}/chapter_workflow/`。
- [direct-gate.ts](direct-gate.ts)：direct 节点闸门包装器 `withDispatchGate`（§5.3 校验接入点）。
- [chapter_workflow/](chapter_workflow/index.ts)：章节 LangGraph 状态、节点接线、条件路由、重试预算和 WorkflowStore 断点恢复。
  [stub-agent.test.ts](tests/stub-agent.test.ts)：StubAgent 行为测试——json/text 响应、轮换、match 分支、无匹配抛错、计数。
  [http-agent.test.ts](tests/http-agent.test.ts)：HttpAgent 适配器测试——json/text 响应、apiKey 头、非 2xx/坏响应/超时转抛错。
  [openai-compatible-agent.test.ts](tests/openai-compatible-agent.test.ts)：OpenAI 兼容适配器测试——system/user 映射、response_format、json 解析、jsonMode=false 兜底、temperature 透传、非 2xx/缺 content/超时转抛错。
  [file-store.test.ts](tests/file-store.test.ts)：JsonFileStore 测试——save/load 回读、不存在章返回 undefined、重复 save 覆盖、目录自动创建与小说标识冲突检查。
  [write.test.ts](tests/write.test.ts)：write 节点指令断言——§7.3 十条禁令全部在指令内（`WRITE_BANS` 计数=10）、context 含拍摄单。

## 当前状态与边界

- **跨章运行时状态**：`FakeBookRuntime` 提供 `snapshot()/restore()`（`fake-book-runtime.ts`，账本/真相/时钟/角色状态；plain JSON 可序列化）；`run-chapters` 每次运行前恢复、结束后落盘 `{store-dir}/{novelId}/chapter_workflow/runtime-state.json`。
- 参考节点的指令文本与 audit/censor 判定规则为**占位**，业务正确性由 B 的节点实现负责；merge 的 weavePlan 暂用 `minimalWeavePlan` 占位（TimelineManager 真实排程待小说流）。
- `WorkflowStore` 已提供 JSON 文件实现（`createJsonFileStore`，断点续跑落地）；§11.3 单事务原子落盘（facts/账本/正文同库）仍待真实存储接入——settle 的原子语义目前由 `BookRuntime.settleChapter` 在内存内保证（拒绝时任何状态不变）。
- 章节图使用固定章节级 `Step`；小说级建书流程由独立 LangGraph 状态图编排。
- 假设（记录于 `.agents/notes/2026-09-21-workflow-engine.md`）：`direct` 完成后 status 仍为 planned（规划步骤）；预算耗尽挂起时 step 停在回退目标步骤。
- 第三方 agent 接入：OpenAI 兼容路线已落地（阿里云 MaaS 实配）；LangChain 原生协议映射与结构化输出保障（RuntimeDelta/Dispatch 的 JSON 形状，必要时加修复层）待实际对接时确认（见 `.agents/notes/2026-09-22-book-runtime-http-agent.md`、`.agents/notes/2026-09-23-openai-compatible-file-store.md`）。
