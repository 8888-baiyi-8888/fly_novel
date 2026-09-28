import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookId } from "../../novel/types";
import { StubAgent } from "../stub-agent";
import { createWriteNode } from "../nodes/write";
import { WRITE_BANS } from "../nodes/write";
import type { AgentGenerateInput, AgentPort } from "../agent-port";
import type { NodeOutput, StepRunContext } from "../types";

const bookId = "demo-book" as BookId;

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
class RecordingAgent implements AgentPort {
  readonly inputs: AgentGenerateInput[] = [];
  constructor(private readonly inner: AgentPort) {}
  async generate(input: AgentGenerateInput) {
    this.inputs.push(input);
    return this.inner.generate(input);
  }
}

test("write 节点：instruction 含 §7.3 全部禁令，context 含拍摄单", async () => {
  const stub = new StubAgent([{ task: "write", responses: [{ text: "正文……" }] }]);
  const recorder = new RecordingAgent(stub);
  const node = createWriteNode(recorder);
  const ctx: StepRunContext = {
    bookId,
    chapter: 1,
    state: { bookId, chapter: 1, step: "write" as const, status: "planned" as const, retries: 0 },
    artifacts: { merge: makeMerge() },
  };
  const result = await node.run(ctx);
  assert.equal(result.outcome.kind, "continue");
  const input = recorder.inputs[0];
  for (const ban of WRITE_BANS) {
    assert.ok(input.instruction.includes(ban), `指令应包含禁令：${ban.slice(0, 12)}…`);
  }
  const parsed = JSON.parse(input.context) as { scenesheet?: { writingPlan?: string } };
  assert.ok(parsed.scenesheet?.writingPlan?.includes("H007"), "context 应含拍摄单");
});

test("write 指令：禁令计数与 §7.3 一致（10 条）", () => {
  assert.equal(WRITE_BANS.length, 10);
});

test("write 节点：agent 调用失败（无规则/超时）→ retry 回 write 而非 fail", async () => {
  // StubAgent 无匹配规则会抛错（模拟超时/网络失败），runAgentTask 捕获为 !ok → 应 retry
  const stub = new StubAgent([]);
  const node = createWriteNode(stub);
  const ctx: StepRunContext = {
    bookId,
    chapter: 1,
    state: { bookId, chapter: 1, step: "write" as const, status: "planned" as const, retries: 0 },
    artifacts: { merge: makeMerge() },
  };
  const result = await node.run(ctx);
  assert.equal(result.outcome.kind, "retry");
  if (result.outcome.kind === "retry") {
    assert.equal(result.outcome.step, "write");
    assert.match(result.outcome.reason, /write agent 调用失败/);
  }
});
