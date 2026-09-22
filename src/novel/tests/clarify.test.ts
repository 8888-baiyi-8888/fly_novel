import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClarificationTurn, DraftValidationError } from "../draft/validate";
import { CreativeDraftAgent, CreativeDraftError } from "../draft/creative-draft-agent";
import { MemoryModel } from "../../harness/adapters/models/memory-model";
import { EXAMPLE_DRAFT } from "../draft/example";

const RAW = "我想写一本都市隐龙流小说。";

const questionsTurn = (questions: string[]): string =>
  JSON.stringify({ questions, draft: null });
const draftTurn = (): string =>
  JSON.stringify({ questions: [], draft: EXAMPLE_DRAFT });

test("澄清轮解析：有问题时 draft 为 null，问题清空时给出草案", () => {
  const asking = parseClarificationTurn({ questions: ["反派是谁？"], draft: null });
  assert.deepEqual(asking.questions, ["反派是谁？"]);
  assert.equal(asking.draft, undefined);

  const done = parseClarificationTurn({ questions: [], draft: EXAMPLE_DRAFT });
  assert.deepEqual(done.questions, []);
  assert.equal(done.draft?.schemaVersion, 2);
});

test("澄清轮解析：questions 非数组时抛 DraftValidationError", () => {
  assert.throws(() => parseClarificationTurn({ questions: "不是数组", draft: null }), DraftValidationError);
  assert.throws(() => parseClarificationTurn({ questions: [""], draft: null }), DraftValidationError);
});

test("澄清：一轮问清后输出完整草案", async () => {
  const model = new MemoryModel({
    responder: (request) =>
      request.messages.length <= 2 ? questionsTurn(["反派是谁？"]) : draftTurn(),
  });
  const asked: string[][] = [];
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async (questions) => {
    asked.push(questions);
    return "沈砚的对手";
  });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], ["反派是谁？"]);
  assert.equal(draft.schemaVersion, 2);
});

test("澄清：最多提问三轮后强制生成草案", async () => {
  const model = new MemoryModel({
    responder: (request) => {
      if (request.messages.length <= 2) return questionsTurn(["q1"]);
      if (request.messages.length <= 4) return questionsTurn(["q2"]);
      if (request.messages.length <= 6) return questionsTurn(["q3"]);
      if (request.messages.length <= 8) return questionsTurn(["q4"]);
      return draftTurn();
    },
  });
  let askedCount = 0;
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async () => {
    askedCount += 1;
    return "回答";
  });
  assert.equal(askedCount, 3);
  assert.equal(draft.schemaVersion, 2);
});

test("澄清：用户输入停止词后提前结束并生成草案", async () => {
  const model = new MemoryModel({
    responder: (request) =>
      request.messages.length <= 2 ? questionsTurn(["还剩一个问题"]) : draftTurn(),
  });
  let askedCount = 0;
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async () => {
    askedCount += 1;
    return "够了";
  });
  assert.equal(askedCount, 1);
  assert.equal(draft.schemaVersion, 2);
});

test("澄清：模型提问轮也给出草案时接受草案并把问题并入 openQuestions", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ questions: ["遗留问题"], draft: EXAMPLE_DRAFT }),
  });
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async () => "不会走到提问");
  assert.equal(draft.schemaVersion, 2);
  assert.ok(draft.openQuestions.includes("遗留问题"));
});

test("澄清：空输入直接失败，不调用模型", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      return draftTurn();
    },
  });
  const agent = new CreativeDraftAgent({ model });
  await assert.rejects(agent.createDraftWithClarification("   ", async () => "x"), {
    name: "CreativeDraftError",
  });
  assert.equal(called, 0);
});

test("澄清：模型反复输出非法结构时重试后抛 CreativeDraftError", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ questions: "非法" }),
  });
  const agent = new CreativeDraftAgent({ model });
  await assert.rejects(agent.createDraftWithClarification(RAW, async () => "x"), {
    name: "CreativeDraftError",
  });
});
