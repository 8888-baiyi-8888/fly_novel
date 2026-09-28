# Agent 端口 + StubAgent + 参考节点：workflow 先行开发

日期：2026-09-22

## 问题

A 的底层 agent（harness/agent-loop）还需要一段时间才能闭环，但章节流 workflow 的
LLM 型节点（direct/simulate/merge/write/audit/censor/settle）都依赖 agent 能力。
若等待 agent 就绪，workflow 无法端到端验证；若直接硬编码 LLM 调用，agent 就绪后又
要大改。需要"预留 agent 位置 + 模拟实现先行"。

## 决定

1. **端口契约** `src/workflow/agent-port.ts`：`AgentPort.generate({ task, instruction, context, outputFormat }) → { text, json? }`。
   task 与章节流七步一一对应（复用 Step）。这是 workflow 消费 agent 的唯一接入面——
   **真实 agent 就绪后实现同一接口注入，引擎与节点零改动**（适配器模式）。
2. **StubAgent** `src/workflow/stub-agent.ts`：确定性模拟——规则表（task 精确 + instruction 子串分支）、
   响应按调用次数轮换（重试场景用）、调用计数（`count(task)` 供测试断言）。无匹配规则抛错（节点转 fail）。
3. **参考节点** `src/workflow/nodes/`：`buildChapterNodes(agent, deps)` 组装 7 步可运行节点——
   - LLM 型节点真实形态：拼 instruction/context → 调 AgentPort → 产物形状校验（parse.ts）→ 失败转 retry/fail；
   - direct 复用 `withDispatchGate` 接入 §5.3 闸门（deps.hookContext/ledger 由调用方注入，真实来源 HookLedger）；
   - merge 的 weavePlan 用 `minimalWeavePlan` 确定性占位（TimelineManager 位置），scenesheet 经 agent；
   - audit/censor 以 PASS/FAIL 前缀做最小判定（FAIL → 回 write 重写）；
   - **指令文本与判定规则均为占位**，真实策略由 B 替换对应工厂。
4. 项目分布不变：不动 harness/llm/novel，全部新增在 `src/workflow/` 下；真实 agent 未来落在 harness 并实现 AgentPort。

## 影响

- workflow 从"骨架 + stub 测试"升级为**端到端可运行**：注入 StubAgent 即跑通 7 步。
- B 的节点开发获得可替换载体：参考节点即真实节点的形态样例（调用/校验/失败处理），
  替换某节点只需实现同签名工厂；A 的 agent 实现 AgentPort 后仅替换注入对象。
- 边界：settle 的六步校验链（§11.2）属 HookLedger.applyDelta，原子落盘（§11.3）属真实
  WorkflowStore，均不在本次范围；merge 的 weavePlan 占位将在 TimelineManager 实现时替换。

## 验证

- `npx tsc -p`（novel + workflow + util）零诊断；全部测试 44/44 通过
  （novel 17；workflow 27 = 引擎 11 + 节点契约 2 + 闸门接线 4 + StubAgent 6 + 端到端 4）。
- 端到端覆盖：7 步全流程产物七项齐全；闸门拒绝 → retry 回 direct → 二次合规跑通；
  审计 FAIL → 回 write 重写 → 二次通过；settle agent 失败 → failed → 修复后断点续跑
  （`agent2.count('direct') === 0` 证明未重跑前序）。
