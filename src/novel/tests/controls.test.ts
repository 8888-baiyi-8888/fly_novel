import test from "node:test";
import assert from "node:assert/strict";

import { MemoryModel } from "../../harness/adapters/models/memory-model";
import { ControlsAgent, ControlsError, parseControlsOutput, ControlsValidationError } from "../controls";
import { EXAMPLE_CONTROLS, EXAMPLE_CONTROLS_JSON } from "../controls/example";
import { LongTermControls } from "../controls/types";
import { EXAMPLE_DRAFT_JSON } from "../draft/example";
import { CreativeDraftAgent } from "../draft/creative-draft-agent";
import { CreativeDraft } from "../draft/types";

/** 生成《隐龙》示例草案（内存版，不落盘）：草凨 Agent 用预置响应返回。 */
async function exampleDraft(): Promise<CreativeDraft> {
  const agent = new CreativeDraftAgent({
    model: new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } }),
  });
  return agent.createDraft(EXAMPLE_DRAFT_JSON);
}

test("controls：合法输出可解析为四件套", () => {
  const parsed = parseControlsOutput(JSON.parse(EXAMPLE_CONTROLS_JSON));
  assert.equal(parsed.authorIntent.includes("反差"), true);
  assert.equal(parsed.currentFocus.length, 5);
  assert.equal(parsed.volumeDirections.length, 3);
  assert.equal(parsed.volumeDirections[0].volume, "第一卷");
  assert.equal(parsed.volumeDirections[2].direction.includes("真相揭示"), true);
  assert.ok(parsed.constraints.length >= 1);
});

test("controls：缺 authorIntent 抛校验错误", () => {
  assert.throws(
    () => parseControlsOutput({ currentFocus: ["a"], volumeDirections: [{ volume: "第一卷", direction: "b" }], constraints: ["c"] }),
    ControlsValidationError,
  );
});

test("controls：volumeDirections 项缺 direction 抛校验错误", () => {
  assert.throws(
    () =>
      parseControlsOutput({
        authorIntent: "a",
        currentFocus: ["a"],
        volumeDirections: [{ volume: "第一卷" }],
        constraints: ["c"],
      }),
    ControlsValidationError,
  );
});

test("controls：非对象输出抛校验错误", () => {
  assert.throws(() => parseControlsOutput("not-json"), ControlsValidationError);
  assert.throws(() => parseControlsOutput(null), ControlsValidationError);
});

test("controls：MemoryModel 内存版返回《隐龙》四件套", async () => {
  const model = new MemoryModel({
    responses: { creative_controls: EXAMPLE_CONTROLS_JSON },
  });
  const agent = new ControlsAgent({ model });
  const draft = await exampleDraft();
  const controls: LongTermControls = await agent.createControls(draft);
  assert.equal(controls.bookId, "yinlong");
  assert.equal(controls.title, "隐龙");
  assert.equal(controls.volumeDirections.length, 3);
  assert.equal(controls.constraints.includes("不虐主"), true);
});

test("controls：第一次输出缺字段 → 重试带反馈 → 成功", async () => {
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({ authorIntent: "ok", currentFocus: [], volumeDirections: [{ volume: "第一卷", direction: "x" }], constraints: ["c"] });
      }
      return EXAMPLE_CONTROLS_JSON;
    },
  });
  const agent = new ControlsAgent({ model, maxRetries: 1 });
  const draft = await exampleDraft();
  const controls = await agent.createControls(draft);
  assert.equal(calls, 2);
  assert.equal(controls.bookId, "yinlong");
});

test("controls：多次重试仍失败 → 抛 ControlsError", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ authorIntent: "ok", currentFocus: [], volumeDirections: [{ volume: "第一卷", direction: "x" }], constraints: ["c"] }),
  });
  const agent = new ControlsAgent({ model, maxRetries: 1 });
  const draft = await exampleDraft();
  await assert.rejects(() => agent.createControls(draft), ControlsError);
});

test("controls：示例常量与解析结果一致", () => {
  assert.equal(EXAMPLE_CONTROLS.bookId, "yinlong");
  assert.equal(EXAMPLE_CONTROLS.currentFocus.length, 5);
  assert.equal(EXAMPLE_CONTROLS.volumeDirections[1].direction.includes("势力重聚"), true);
});

test("controls：agent 产出 bookId 来自书名拼音 slug（确定性）", async () => {
  const model = new MemoryModel({ responses: { creative_controls: EXAMPLE_CONTROLS_JSON } });
  const agent = new ControlsAgent({ model });
  const draft = await exampleDraft();
  const controls = await agent.createControls(draft);
  assert.equal(controls.bookId, "yinlong");
});
