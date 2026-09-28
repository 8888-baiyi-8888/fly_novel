# 2026-09-23：真实 agent 接入（OpenAI 兼容适配器）+ 断点存储 + 驱动入口

## 问题

用户提供真实 agent 端点（阿里云 MaaS，`https://ws-…maas.aliyuncs.com/compatible-mode/v1`，OpenAI 兼容形态，有 apiKey），目标是「真实 agent + 模拟 Book Runtime 跑通章节流」。上一轮差距清单中三个缺口需补齐：①真实 agent 的协议适配；②WorkflowStore 持久化（当时只有测试内存实现）；③驱动入口（无脚本把 agent+runtime+nodes+engine+store 串起来）。

## 决定

1. **OpenAICompatibleAgent**（`src/workflow/openai-compatible-agent.ts`）：识别端点为 `compatible-mode/v1` → OpenAI 兼容协议（POST `/chat/completions`、`Authorization: Bearer <key>`）。映射：`instruction→system`、`context→user`；`outputFormat=json` 且 `jsonMode=true`（默认）→ 请求 `response_format={type:'json_object'}`；响应取 `choices[0].message.content` 为 text，json 模式顺带尝试 `JSON.parse` 塞 json 字段（解析失败不抛错，回退 text——节点侧 `jsonFromOutput` 还有一层兜底）。非 2xx / 超时 / 缺 content 抛错（`runAgentTask` 转 fail）。`temperature` 可选透传；`fetchImpl` 注入供测试（无密钥环境用替身，不发真实调用）。
2. **JsonFileStore**（`src/workflow/file-store.ts`）：`WorkflowStore` 的 JSON 文件实现——布局 `{dir}/{bookId}/{chapter}.json`；写 `{chapter}.json.tmp` 再 rename（原子替换防半写）；load 遇 ENOENT 返回 undefined（新章从头跑）；JSON 损坏抛错不静默吞。§11.3 单事务存储（facts/账本同库）仍待小说流真实存储，本实现先让断点续跑落地。
3. **run-chapter.ts**（`src/workflow/run-chapter.ts`）：驱动入口（示例/调试用，**不从 workflow/index 导出**）——真实 OpenAI 兼容 agent + `buildFakeBookRuntime`（§7.7 fixture）+ JsonFileStore + `ChapterWorkflow`，端到端跑一章；参数 `--base-url / --model / --api-key / --book / --chapter / --store-dir / --temperature`，缺省读环境变量 `FLY_NOVEL_BASE_URL / FLY_NOVEL_MODEL / FLY_NOVEL_API_KEY`；事件经 notify 打印；结果打印账本摘要与断点文件路径。
4. **入口补齐**：`workflow/index.ts` 增导 `createHttpAgent`（上一轮发现遗漏）与 `createOpenAICompatibleAgent`、`createJsonFileStore`。
5. 真实 key 不进代码：适配器收裸 key 自动加 `Bearer `；凭据基建已有 `config/credentials.ts`（AES-256-GCM）与 `app/credentials-cli.ts`。

## 影响

- 章节流从「StubAgent + FakeBookRuntime」升级为「**真实 agent + FakeBookRuntime**」可跑：节点/引擎/契约零改动，只换 AgentPort 实现。
- 协议假设：`baseUrl` 含版本前缀（`.../compatible-mode/v1`），适配器在其后拼 `/chat/completions`；MaaS 专属实例的模型名（`model`）由服务方提供，驱动时必填。
- JSON 可靠性防线现为三层：`response_format=json_object` → 适配器 text 解析 → 节点形状校验 + retry；真实跑动后再评估是否加修复层。
- 阿里云 MaaS 端点可能要求特定模型名/部署名；`jsonMode` 若端点不支持可置 false（靠 prompt + 解析兜底）。

## 验证

- `npx tsc -p tsconfig.chapters.json` 零诊断；全量 `node --test` **114/114 通过**（原 104 + openai-compatible 6 + file-store 4）。
- openai-compatible-agent.test.ts：system/user 映射与 URL 拼接、response_format 与 json 解析、jsonMode=false 兜底、temperature 透传、非 2xx / 缺 content / 超时抛错（fetchImpl 替身，无真实调用）。
- file-store.test.ts：save/load 回读、不存在章 undefined、重复 save 覆盖、目录自动创建与多 bookId 分目录（临时目录，用后清理）。
- run-chapter.js 缺参冒烟：正确提示缺 `--base-url/--model/--api-key` 并以非零退出。
- 真实端到端（真实 key）未在本环境执行——需用户填入 key/model 后按 README 命令运行；`openai-compatible-agent` 的协议字段已按 OpenAI 兼容规范实现，若端点有差异按实际响应修正。

## 追记：真实 agent 首跑暴露的 direct 形状问题（同批修复）

**现象**：真实模型（qwen3.8-omni-flash）返回 `{"chapter":1,"dispatch":[{hookId,action,...}...]}`——模型**自创 schema**（把 dispatch 当成指令列表），parseDispatch 报「缺 goal/castPlan/threadPlan/styleNotes/budget/hookDirectives」。根因：direct 指令只有要求描述、没有给出确切 JSON 形状，模型自由发挥；且 context 未给线程快照，模型无法引用合法 threadId。

**修复**（`nodes/direct.ts`）：
1. `DIRECT_INSTRUCTION`（导出为常量）嵌入 **Dispatch 完整结构示例（few-shot）**——含字段类型/枚举（tier/role/slot/payoffTiming/type）、全部数组字段、最小合法示例；明确禁止 Markdown 代码块、禁止额外包装键（如 `dispatch`）、禁止缺数组。
2. context 增注 `threads: runtime.timeline.snapshotFor(chapter)`（线程快照）——threadId/eventId 有据可依。
3. `describeDispatchFailure` 缺字段时附**原始 JSON 预览**（前 300 字符），定位模型实际输出。
4. 顺带确认：MaaS 模型名大小写敏感（`Qwen3.8-Omni-Flash` 404 / `qwen3.8-omni-flash` 200）；适配器增 `maxTokens`（`--max-tokens` 透传），防长 JSON 被截断。

**验证**：tsc 零诊断；122/122（新增：parse 预览用例、direct 节点 instruction/context 用例）。真实模型重跑待用户执行；若仍不合格，新诊断会带原始 JSON 预览可继续定位。
