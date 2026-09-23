import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawInput, RawInputValidationError } from "../raw-input/validate";
import { RawInputAgent, RawInputError } from "../raw-input/raw-input-agent";
import { MemoryModel } from "../../harness/adapters/models/memory-model";

const INITIAL = "我想写霸道女上司爱上初入职场的小白妹妹，不要太狗血，内容励志。";
const TEXT = "我想写一本都市职场百合文。霸道女上司沈砚与初入职场的小白妹妹林小满……";

test("N0 解析：rawInput 非空字符串时返回文本", () => {
  assert.equal(parseRawInput({ rawInput: TEXT }), TEXT);
});

test("N0 解析：rawInput 缺失或为空串时抛 RawInputValidationError", () => {
  assert.throws(() => parseRawInput({}), RawInputValidationError);
  assert.throws(() => parseRawInput({ rawInput: null }), RawInputValidationError);
  assert.throws(() => parseRawInput({ rawInput: "   " }), RawInputValidationError);
  assert.throws(() => parseRawInput({ rawInput: 123 }), RawInputValidationError);
});

test("N0：单次调用即返回整理文本（不反问用户）", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: (request) => {
      called += 1;
      assert.equal(request.messages.length, 2);
      return JSON.stringify({ rawInput: TEXT });
    },
  });
  const agent = new RawInputAgent({ model });
  const rawInput = await agent.createRawInput(INITIAL);
  assert.equal(called, 1);
  assert.equal(rawInput, TEXT);
});

test("N0：空输入直接失败，不调用模型", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      return JSON.stringify({ rawInput: TEXT });
    },
  });
  const agent = new RawInputAgent({ model });
  await assert.rejects(agent.createRawInput("   "), { name: "RawInputError" });
  assert.equal(called, 0);
});

test("N0：模型输出非法结构时重试后抛 RawInputError", async () => {
  const model = new MemoryModel({ responder: () => JSON.stringify({ rawInput: null }) });
  const agent = new RawInputAgent({ model });
  await assert.rejects(agent.createRawInput(INITIAL), { name: "RawInputError" });
});

test("N0：首次输出非法、重试成功时返回整理文本", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      return called === 1 ? JSON.stringify({}) : JSON.stringify({ rawInput: TEXT });
    },
  });
  const agent = new RawInputAgent({ model });
  assert.equal(await agent.createRawInput(INITIAL), TEXT);
  assert.equal(called, 2);
});
