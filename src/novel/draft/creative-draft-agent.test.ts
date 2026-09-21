import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAndValidateDraft, DraftValidationError } from "./validate";
import { CreativeDraftAgent, CreativeDraftError } from "./creative-draft-agent";
import { MemoryModel } from "../../harness/adapters/models/memory-model";
import { EXAMPLE_DRAFT, EXAMPLE_DRAFT_JSON } from "./example";

test("合法草案对象通过校验并规范化", () => {
  const draft = parseAndValidateDraft(JSON.parse(EXAMPLE_DRAFT_JSON));
  assert.equal(draft.schemaVersion, 1);
  assert.deepEqual(draft.genre, EXAMPLE_DRAFT.genre);
  assert.equal(draft.protagonist?.name, "叶凡");
});

test("新字段（运行参数/作者意图/配角）通过校验并保留", () => {
  const draft = parseAndValidateDraft(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        genre: ["都市"],
        tone: ["信息差"],
        rawSummary: "x",
        platform: "番茄",
        targetChapters: 100,
        chapterWordCount: 2500,
        language: "zh",
        authorIntent: "信息差爽点",
        worldPremise: "当代都市",
        currentFocus: ["立起离婚协议伏笔"],
        blurb: "龙王殿殿主隐姓埋名入赘",
        supportingCast: [{ name: "苏晴", identity: "江氏品牌部职员", relation: "妻子" }],
      }),
    ),
  );
  assert.equal(draft.platform, "番茄");
  assert.equal(draft.targetChapters, 100);
  assert.equal(draft.chapterWordCount, 2500);
  assert.equal(draft.language, "zh");
  assert.equal(draft.authorIntent, "信息差爽点");
  assert.equal(draft.worldPremise, "当代都市");
  assert.deepEqual(draft.currentFocus, ["立起离婚协议伏笔"]);
  assert.equal(draft.blurb, "龙王殿殿主隐姓埋名入赘");
  assert.equal(draft.supportingCast?.[0]?.name, "苏晴");
  assert.equal(draft.supportingCast?.[0]?.relation, "妻子");
});

test("可选字段缺失时返回 undefined（不报错）", () => {
  const draft = parseAndValidateDraft({ schemaVersion: 1, genre: ["都市"], tone: ["信息差"], rawSummary: "x" });
  assert.equal(draft.platform, undefined);
  assert.equal(draft.protagonist, undefined);
  assert.equal(draft.supportingCast, undefined);
});

test("supportingCast 项缺 name 时校验失败", () => {
  assert.throws(
    () =>
      parseAndValidateDraft({
        schemaVersion: 1,
        genre: ["都市"],
        tone: ["信息差"],
        rawSummary: "x",
        supportingCast: [{ identity: "没有名字" }],
      }),
    DraftValidationError,
  );
});

test("缺少必填字段时校验失败", () => {
  assert.throws(
    () => parseAndValidateDraft({ schemaVersion: 1, genre: ["都市"], tone: [], rawSummary: "" }),
    DraftValidationError,
  );
});

test("版本不匹配时校验失败", () => {
  assert.throws(
    () =>
      parseAndValidateDraft({
        schemaVersion: 2,
        genre: ["都市"],
        tone: ["信息差"],
        rawSummary: "x",
      }),
    DraftValidationError,
  );
});

test("Agent 用内存模型整理出草案", async () => {
  const model = new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } });
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraft("我想写一本都市隐龙流小说，主角是龙王殿殿主。");
  assert.equal(draft.title, EXAMPLE_DRAFT.title);
  assert.equal(draft.genre[0], "都市");
  assert.equal(draft.platform, "番茄");
});

test("Agent 首次返回非法 JSON，重试后成功", async () => {
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      return calls === 1 ? "这不是 JSON" : EXAMPLE_DRAFT_JSON;
    },
  });
  const agent = new CreativeDraftAgent({ model });
  const draft = await agent.createDraft("输入");
  assert.equal(calls, 2);
  assert.ok(draft.rawSummary.length > 0);
});

test("重试仍失败时抛出 CreativeDraftError", async () => {
  const model = new MemoryModel({ forceContent: "{}" });
  const agent = new CreativeDraftAgent({ model, maxRetries: 1 });
  await assert.rejects(() => agent.createDraft("输入"), CreativeDraftError);
});

test("空输入直接失败，不调用模型", async () => {
  let called = false;
  const model = new MemoryModel({
    responder: () => {
      called = true;
      return EXAMPLE_DRAFT_JSON;
    },
  });
  const agent = new CreativeDraftAgent({ model });
  await assert.rejects(() => agent.createDraft("   "), CreativeDraftError);
  assert.equal(called, false);
});
