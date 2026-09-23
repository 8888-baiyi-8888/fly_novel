import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAndValidateDraft, DraftValidationError } from "../draft/validate";
import { CreativeDraftAgent, CreativeDraftError } from "../draft/creative-draft-agent";
import { MemoryModel } from "../../harness/adapters/models/memory-model";
import { EXAMPLE_DRAFT, EXAMPLE_DRAFT_JSON } from "../draft/example";

/** 最小合法草案：N1 必填契约（对齐文档输出实例）要求字段齐全，各用例基于它覆盖/扩展。 */
const MINIMAL_DRAFT = {
  schemaVersion: 2,
  title: "测试书名",
  genre: ["都市"],
  protagonists: [{ name: "叶凡" }],
  worldPremise: "当代都市",
  coreConflict: "核心冲突",
  authorIntent: "作者意图",
  tone: ["信息差"],
  volumePlan: ["第一卷：借势反噬"],
  constraints: ["不虐主"],
  platform: "番茄",
  targetChapters: 100,
  chapterWordCount: 2500,
  language: "zh",
  rawSummary: "x",
};

test("合法草案对象通过校验并规范化", () => {
  const draft = parseAndValidateDraft(JSON.parse(EXAMPLE_DRAFT_JSON));
  assert.equal(draft.schemaVersion, 2);
  assert.deepEqual(draft.genre, EXAMPLE_DRAFT.genre);
  assert.equal(draft.protagonists?.[0]?.name, "叶凡");
});

test("多主角数组通过校验（双女主场景）", () => {
  const draft = parseAndValidateDraft(
    JSON.parse(
      JSON.stringify({
        ...MINIMAL_DRAFT,
        protagonists: [
          { name: "林小满", age: 22, identity: "应届生", coreNeed: "摆脱自我否定" },
          { name: "沈砚", age: 32, identity: "创意总监", coreNeed: "学会信任" },
        ],
      }),
    ),
  );
  assert.equal(draft.protagonists?.length, 2);
  assert.equal(draft.protagonists?.[0]?.name, "林小满");
  assert.equal(draft.protagonists?.[1]?.name, "沈砚");
});

test("v1 草案自动迁移：单数 protagonist 并入 protagonists 数组", () => {
  const draft = parseAndValidateDraft({
    ...MINIMAL_DRAFT,
    schemaVersion: 1,
    protagonist: { name: "叶凡", identity: "龙王殿殿主" },
  });
  assert.equal(draft.schemaVersion, 2);
  assert.equal(draft.protagonists?.length, 1);
  assert.equal(draft.protagonists?.[0]?.name, "叶凡");
  assert.equal(draft.protagonists?.[0]?.identity, "龙王殿殿主");
});

test("模型误输出单数 protagonist 数组也能兜底并入（不丢主角）", () => {
  const draft = parseAndValidateDraft({
    ...MINIMAL_DRAFT,
    protagonists: undefined,
    protagonist: [{ name: "林小满" }, { name: "沈砚" }],
  });
  assert.equal(draft.protagonists?.length, 2);
  assert.equal(draft.protagonists?.[0]?.name, "林小满");
  assert.equal(draft.protagonists?.[1]?.name, "沈砚");
});

test("新字段（运行参数/作者意图/配角）通过校验并保留", () => {
  const draft = parseAndValidateDraft(
    JSON.parse(
      JSON.stringify({
        ...MINIMAL_DRAFT,
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
  assert.equal(draft.authorIntent, "作者意图");
  assert.equal(draft.worldPremise, "当代都市");
  assert.deepEqual(draft.currentFocus, ["立起离婚协议伏笔"]);
  assert.equal(draft.blurb, "龙王殿殿主隐姓埋名入赘");
  assert.equal(draft.supportingCast?.[0]?.name, "苏晴");
  assert.equal(draft.supportingCast?.[0]?.relation, "妻子");
});

test("空字符串 title 视为必填缺失，校验失败", () => {
  assert.throws(() => parseAndValidateDraft({ ...MINIMAL_DRAFT, title: "" }), DraftValidationError);
});

test("可选字段缺失时返回 undefined（必填字段齐全）", () => {
  const draft = parseAndValidateDraft({ ...MINIMAL_DRAFT });
  assert.equal(draft.protagonists.length, 1);
  assert.equal(draft.supportingCast, undefined);
  assert.equal(draft.setting, undefined);
  assert.equal(draft.blurb, undefined);
  assert.equal(draft.currentFocus, undefined);
});

test("protagonists 项缺 name 时校验失败", () => {
  assert.throws(
    () =>
      parseAndValidateDraft({
        ...MINIMAL_DRAFT,
        protagonists: [{ identity: "没有名字" }],
      }),
    DraftValidationError,
  );
});

test("supportingCast 项缺 name 时校验失败", () => {
  assert.throws(
    () =>
      parseAndValidateDraft({
        ...MINIMAL_DRAFT,
        supportingCast: [{ identity: "没有名字" }],
      }),
    DraftValidationError,
  );
});

test("缺少必填字段时校验失败", () => {
  assert.throws(
    () =>
      parseAndValidateDraft({
        schemaVersion: 2,
        genre: ["都市"],
        tone: [],
        rawSummary: "",
        protagonists: [{ name: "叶凡" }],
      }),
    DraftValidationError,
  );
});

test("版本不匹配时校验失败", () => {
  assert.throws(
    () => parseAndValidateDraft({ ...MINIMAL_DRAFT, schemaVersion: 3 }),
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
