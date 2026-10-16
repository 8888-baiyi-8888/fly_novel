import assert from "node:assert/strict";
import { test } from "node:test";
import type { NovelId } from "../../novel/types";
import { StubAgent } from "../stub-agent";
import { createWriteNode } from "../chapter_workflow/nodes/write";
import type { ContentAgent } from "../agent-port";
import type { NodeOutput, StepRunContext } from "../types";

const novelId = "demo-book" as NovelId;

/** 测试 fixture：绕过 branded 类型（EventId/CharacterName/HookId），结构对齐 MergeArtifacts。 */
function makeMerge(): NodeOutput {
  return {
    weavePlan: { mainEvents: ["E-M07"], sideInserts: [], blocked: [] },
    scenesheet: {
      writingPlan: "本章按 1 章调度：第 2 场收束 H007。",
      scenes: [
        {
          no: 1,
          kind: "main",
          pov: "叶凡",
          slot: "start",
          purpose: "引入",
          beats: ["协议出现"],
          cast: ["叶凡", "苏晴"],
          material: { lines: ["这墨迹不对"], actions: ["摩挲协议"], suspects: [] },
          hookOps: [{ hookId: "H007", op: "advance", how: "发现墨迹异常" }],
          budgetChars: 800,
          emotion: "沉郁",
        },
      ],
      weavingNotes: "雨声贯穿",
      forbidden: ["不得新增角色"],
    },
  } as unknown as NodeOutput;
}

/** 记录传给 agent 的原始输入（供指令/上下文断言）。 */
class RecordingAgent implements ContentAgent {
  readonly inputs: string[] = [];
  constructor(private readonly inner: StubAgent) {}
  async generate(content: string) {
    this.inputs.push(content);
    const result = await this.inner.generate({ task: "write", instruction: "", context: content });
    return { messages: [{ type: "ai", content: result.text }] };
  }
}

test("write 节点：只传本章任务指令与拍摄单材料", async () => {
  const stub = new StubAgent([{ task: "write", responses: [{ text: "正文……".repeat(40) }] }]);
  const recorder = new RecordingAgent(stub);
  const node = createWriteNode(recorder);
  const ctx: StepRunContext = {
    novelId,
    chapter: 1,
    state: { novelId, chapter: 1, step: "write" as const, status: "planned" as const, retries: 0 },
    artifacts: { merge: makeMerge() },
  };
  const result = await node.run(ctx);
  assert.equal(result.outcome.kind, "continue");
  const input = recorder.inputs[0] ?? "";
  assert.match(input, /根据本章排程方案与拍摄单撰写完整正文/);
  assert.ok(!input.includes("禁黑名单句式"), "稳定写作禁令由 WriterAgent 系统提示词提供");
  const contextText = input.split("本章写作材料：\n")[1] ?? "{}";
  const parsed = JSON.parse(contextText) as { scenesheet?: { writingPlan?: string } };
  assert.ok(parsed.scenesheet?.writingPlan?.includes("H007"), "context 应含拍摄单");
});

test("write 节点：agent 调用失败（无规则/超时）→ retry 回 write 而非 fail", async () => {
  // StubAgent 无匹配规则会抛错（模拟超时/网络失败），runAgentTask 捕获为 !ok → 应 retry
  const stub = new StubAgent([]);
  const node = createWriteNode(new RecordingAgent(stub));
  const ctx: StepRunContext = {
    novelId,
    chapter: 1,
    state: { novelId, chapter: 1, step: "write" as const, status: "planned" as const, retries: 0 },
    artifacts: { merge: makeMerge() },
  };
  const result = await node.run(ctx);
  assert.equal(result.outcome.kind, "retry");
  if (result.outcome.kind === "retry") {
    assert.equal(result.outcome.step, "write");
    assert.match(result.outcome.reason, /write agent 调用失败/);
  }
});
