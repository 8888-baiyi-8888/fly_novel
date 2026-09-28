import assert from "node:assert/strict";
import { test } from "node:test";
import { StubAgent } from "../stub-agent";
import type { AgentTask } from "../agent-port";

function call(agent: StubAgent, task: AgentTask, instruction = "指令", outputFormat?: "text" | "json") {
  return agent.generate({ task, instruction, context: "{}", outputFormat });
}

test("json 响应：text 为序列化结果，json 原样返回", async () => {
  const agent = new StubAgent([{ task: "direct", responses: [{ json: { a: 1 } }] }]);
  const out = await call(agent, "direct");
  assert.equal(out.text, '{"a":1}');
  assert.deepEqual(out.json, { a: 1 });
});

test("text 响应：原样返回", async () => {
  const agent = new StubAgent([{ task: "write", responses: [{ text: "第 21 章正文……" }] }]);
  const out = await call(agent, "write");
  assert.equal(out.text, "第 21 章正文……");
  assert.equal(out.json, undefined);
});

test("轮换：按调用次数依次取响应，用尽后固定最后一个", async () => {
  const agent = new StubAgent([
    { task: "direct", responses: [{ json: { bad: true } }, { json: { ok: true } }] },
  ]);
  assert.deepEqual((await call(agent, "direct")).json, { bad: true });
  assert.deepEqual((await call(agent, "direct")).json, { ok: true });
  assert.deepEqual((await call(agent, "direct")).json, { ok: true });
});

test("match：instruction 含子串才匹配，同任务可分支", async () => {
  const agent = new StubAgent([
    { task: "audit", match: "FAIL", responses: [{ text: "FAIL 漏收 H007" }] },
    { task: "audit", responses: [{ text: "PASS" }] },
  ]);
  assert.equal((await call(agent, "audit", "审计正文，FAIL 则重写")).text, "FAIL 漏收 H007");
  assert.equal((await call(agent, "audit", "正常审计")).text, "PASS");
});

test("无匹配规则：抛错（节点侧转 fail）", async () => {
  const agent = new StubAgent([{ task: "direct", responses: [{ json: {} }] }]);
  await assert.rejects(call(agent, "settle"), /无匹配规则/);
});

test("count：按任务统计调用次数", async () => {
  const agent = new StubAgent([
    { task: "direct", responses: [{ json: {} }] },
    { task: "write", responses: [{ text: "x" }] },
  ]);
  await call(agent, "direct");
  await call(agent, "direct");
  await call(agent, "write");
  assert.equal(agent.count("direct"), 2);
  assert.equal(agent.count("write"), 1);
  assert.equal(agent.count("settle"), 0);
  assert.equal(agent.count(), 3);
});
