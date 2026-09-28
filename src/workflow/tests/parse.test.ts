import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentGenerateOutput } from "../agent-port";
import { describeDispatchFailure, parseDispatch } from "../nodes/parse";

function textOut(text: string): AgentGenerateOutput {
  return { text };
}

const validDispatch = {
  chapter: 1,
  goal: "g",
  castPlan: [],
  threadPlan: [],
  hookDirectives: { open: [], advance: [], resolve: [], defer: [], mention: [] },
  styleNotes: [],
  budget: { scenes: 4, chars: 5 },
};

test("describeDispatchFailure：合法 Dispatch 不被误报", () => {
  const out: AgentGenerateOutput = { text: JSON.stringify(validDispatch), json: validDispatch };
  assert.notEqual(parseDispatch(out), undefined);
  assert.match(describeDispatchFailure(out), /形状不满足/); // 保底分支（完整形状不会走到）
});

test("describeDispatchFailure：text 非 JSON → 报预览（区分空输出）", () => {
  assert.match(describeDispatchFailure(textOut("```json\n{...}")), /不是合法 JSON.*预览：```json/);
  assert.match(describeDispatchFailure(textOut("   ")), /不是合法 JSON.*空输出/);
});

test("describeDispatchFailure：缺 hookDirectives 或顶层字段 → 点名缺/错字段", () => {
  assert.match(describeDispatchFailure(textOut('{"chapter":1}')), /hookDirectives\(object\)/);
  const noGoal = { ...validDispatch };
  delete (noGoal as Record<string, unknown>).goal;
  assert.match(describeDispatchFailure(textOut(JSON.stringify(noGoal))), /goal\(string\)/);
});

test("describeDispatchFailure：hookDirectives 缺子数组 → 点名缺的数组", () => {
  const noMention = { ...validDispatch, hookDirectives: { open: [], advance: [], resolve: [], defer: [] } };
  assert.match(describeDispatchFailure(textOut(JSON.stringify(noMention))), /hookDirectives\.mention\(array\)/);
});

test("describeDispatchFailure：budget 非对象 → 点名", () => {
  assert.match(describeDispatchFailure(textOut(JSON.stringify({ ...validDispatch, budget: 5 }))), /budget\(object\)/);
});

test("describeDispatchFailure：缺字段时附带原始 JSON 预览（定位模型实际输出）", () => {
  const msg = describeDispatchFailure(textOut('{"chapter":1}'));
  assert.match(msg, /缺\/错字段：/);
  assert.match(msg, /原始 JSON 预览：\{"chapter":1\}/);
});

test("describeDispatchFailure：JSON 顶层是数组 → 明确提示", () => {
  assert.match(describeDispatchFailure(textOut("[1,2,3]")), /JSON 顶层不是对象/);
});
