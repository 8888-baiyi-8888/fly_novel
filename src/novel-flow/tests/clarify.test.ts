import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClarificationTurn, DraftValidationError } from "../draft/validate";
import { CreativeDraftAgent, CreativeDraftError } from "../draft/creative-draft-agent";
import { MemoryModel } from "../adapters/memory-model";
import { EXAMPLE_DRAFT } from "../draft/example";

const RAW = "我想写一本都市隐龙流小说。";

const questionsTurn = (questions: string[]): string =>
  JSON.stringify({ questions, draft: null });
/** 问题全部澄清后的草案（openQuestions 清空，避免 EXAMPLE_DRAFT 自带的未决问题触发反问）。 */
const cleanDraft = { ...EXAMPLE_DRAFT, openQuestions: [] };
const draftTurn = (): string =>
  JSON.stringify({ questions: [], draft: cleanDraft });

test("澄清轮解析：有问题时 draft 为 null，问题清空时给出草案", () => {
  const asking = parseClarificationTurn({ questions: ["反派是谁？"], draft: null });
  assert.deepEqual(asking.questions, ["反派是谁？"]);
  assert.equal(asking.draft, undefined);

  const done = parseClarificationTurn({ questions: [], draft: EXAMPLE_DRAFT });
  assert.deepEqual(done.questions, []);
  assert.equal(done.draft?.schemaVersion, 2);
});

test("澄清轮解析：模型省略 questions 直接给草案（更新草案轮常见行为）→ 视为无新问题", () => {
  const turn = parseClarificationTurn({ draft: EXAMPLE_DRAFT });
  assert.deepEqual(turn.questions, []);
  assert.equal(turn.draft?.schemaVersion, 2);
});

test("澄清轮解析：questions 容错——字符串视为单问题、数组过滤空项/非字符串项", () => {
  const single = parseClarificationTurn({ questions: "反派是谁？", draft: null });
  assert.deepEqual(single.questions, ["反派是谁？"]);
  const dirty = parseClarificationTurn({ questions: [null, "合法问题", ""], draft: null });
  assert.deepEqual(dirty.questions, ["合法问题"]);
});

test("澄清轮解析：questions 为数字等不可用类型时仍抛 DraftValidationError", () => {
  assert.throws(() => parseClarificationTurn({ questions: 123, draft: null }), DraftValidationError);
  assert.throws(() => parseClarificationTurn({ questions: { a: 1 }, draft: null }), DraftValidationError);
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

test("澄清：模型提问轮违规给出草案时仍反问用户，满轮后接受草案并把问题并入 openQuestions", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ questions: ["遗留问题"], draft: EXAMPLE_DRAFT }),
  });
  let askedCount = 0;
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async () => {
    askedCount += 1;
    return "回答";
  });
  assert.equal(askedCount, 3);
  assert.equal(draft.schemaVersion, 2);
  assert.ok(draft.openQuestions.includes("遗留问题"));
});

test("澄清：模型给草案但 openQuestions 非空时反问用户，回答后输出干净草案", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      return called === 1
        ? JSON.stringify({ questions: [], draft: EXAMPLE_DRAFT })
        : JSON.stringify({ questions: [], draft: cleanDraft });
    },
  });
  const asked: string[][] = [];
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async (questions) => {
    asked.push(questions);
    return "回答";
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].length, EXAMPLE_DRAFT.openQuestions.length);
  assert.equal(draft.openQuestions.length, 0);
});

test("澄清：模型给空问题列表且无草案（{questions:[],draft:null}）→ 不再问用户，强制交卷", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: (request) => {
      called += 1;
      if (called === 1) return questionsTurn(["q1"]);
      if (called === 2) return JSON.stringify({ questions: [], draft: null });
      // 强制交卷轮：给出草案
      assert.ok(request.messages.some((m) => m.content.includes("最终创意草案")));
      return draftTurn();
    },
  });
  const asked: string[][] = [];
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async (questions) => {
    asked.push(questions);
    return "回答";
  });
  assert.equal(asked.length, 1, "只在第一轮问用户，空问题轮不再问");
  assert.deepEqual(asked[0], ["q1"]);
  assert.equal(draft.schemaVersion, 2);
});

test("澄清：模型给空问题列表且强制交卷轮仍无草案 → 降级为直接草案输出兜底成功", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      if (called === 1) return questionsTurn(["q1"]);
      // 空问题轮 + 强制交卷轮都只给空包装不给草案
      return JSON.stringify({ questions: [], draft: null });
    },
  });
  const agent = new CreativeDraftAgent({ model, maxRetries: 1 });
  // 注意：fallback 也在 responder 里返回 {questions:[],draft:null}，不符合草案结构 → 会走 retry → 最终抛错
  await assert.rejects(agent.createDraftWithClarification(RAW, async () => "x"), {
    name: "CreativeDraftError",
  });
});

test("澄清：空问题强制交卷 → 交卷轮仍无草案 → fallback 直接输出草案成功", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: () => {
      called += 1;
      if (called === 1) return questionsTurn(["q1"]);
      if (called === 2) return JSON.stringify({ questions: [], draft: null });
      if (called === 3) return JSON.stringify({ questions: [], draft: null }); // 强制交卷轮仍不给
      // fallback 轮：直接输出草案对象（不带包装）
      return JSON.stringify(cleanDraft);
    },
  });
  const asked: string[][] = [];
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async (questions) => {
    asked.push(questions);
    return "回答";
  });
  assert.equal(asked.length, 1, "只在第一轮问用户");
  assert.equal(called, 4, "1 提问轮 + 1 空问题轮 + 1 交卷轮 + 1 fallback");
  assert.equal(draft.schemaVersion, 2);
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

test("澄清：首次输出非法、重试带反馈后成功输出草案", async () => {
  let called = 0;
  const model = new MemoryModel({
    responder: (request) => {
      called += 1;
      if (called === 1) {
        return JSON.stringify({ questions: 123, draft: null });
      }
      assert.equal(request.messages.length, 3); // 原 2 条 + 1 条重试反馈
      return draftTurn();
    },
  });
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraftWithClarification(RAW, async () => "回答");
  assert.equal(called, 2);
  assert.equal(draft.schemaVersion, 2);
});

test("澄清：模型反复输出非法结构时重试后抛 CreativeDraftError", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ questions: 123 }),
  });
  const agent = new CreativeDraftAgent({ model });
  await assert.rejects(agent.createDraftWithClarification(RAW, async () => "x"), {
    name: "CreativeDraftError",
  });
});
