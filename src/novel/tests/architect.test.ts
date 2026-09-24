import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArchitectOutput, ArchitectValidationError } from "../architect/validate";
import { ArchitectAgent, ArchitectError, buildBookRules } from "../architect/architect-agent";
import { AI_REDLINES } from "../architect/ai-redlines";
import { EXAMPLE_ARCHITECT_JSON, EXAMPLE_STORY_BIBLE } from "../architect/example";
import { MemoryModel } from "../../harness/adapters/models/memory-model";
import { EXAMPLE_DRAFT } from "../draft/example";
import { buildBookConfig } from "../book-config/book-config";

const BRIEF = "《隐龙》——都市隐龙流，番茄小说。一句话故事：龙王殿殿主隐姓埋名入赘查灭门案。";

test("架构师输出：合法结构解析通过，sections 带编号", () => {
  const { storyBible, bookRules } = parseArchitectOutput(JSON.parse(EXAMPLE_ARCHITECT_JSON));
  assert.equal(storyBible.length, 6);
  assert.equal(storyBible[0].id, "S01");
  assert.equal(storyBible[0].title, "当代背景");
  assert.ok(storyBible[0].content.length > 0);
  assert.equal(bookRules.length, 7);
  assert.ok(bookRules[0].content.length > 0);
});

test("架构师输出：storyBible 缺失或空数组报错", () => {
  assert.throws(() => parseArchitectOutput({ bookRules: [{ content: "x" }] }), ArchitectValidationError);
  assert.throws(
    () => parseArchitectOutput({ storyBible: [], bookRules: [{ content: "x" }] }),
    ArchitectValidationError,
  );
});

test("架构师输出：bookRules 缺失或空数组报错", () => {
  assert.throws(
    () => parseArchitectOutput({ storyBible: [{ title: "a", content: "b" }] }),
    ArchitectValidationError,
  );
});

test("架构师输出：项缺 title/content 报错", () => {
  assert.throws(
    () =>
      parseArchitectOutput({
        storyBible: [{ title: "", content: "b" }],
        bookRules: [{ content: "x" }],
      }),
    ArchitectValidationError,
  );
  assert.throws(
    () =>
      parseArchitectOutput({
        storyBible: [{ title: "a", content: "b" }],
        bookRules: [{ content: " " }],
      }),
    ArchitectValidationError,
  );
});

test("AI 红线：内置常量共 11 条", () => {
  assert.equal(AI_REDLINES.length, 11);
  assert.ok(AI_REDLINES[0].includes("不是…而是…"));
  assert.ok(AI_REDLINES[10].includes("套路化比喻"));
});

test("buildBookRules：书特定规则 R 编号 + 内置 AI 红线 A 编号合并", () => {
  const generated = [{ content: "叶凡必须谨慎克制" }, { content: "反派禁止降智" }];
  const rules = buildBookRules("yinlong", "隐龙", generated);
  assert.equal(rules.bookId, "yinlong");
  assert.equal(rules.rules.length, 2 + AI_REDLINES.length);
  assert.equal(rules.rules[0].id, "R01");
  assert.equal(rules.rules[0].category, "story");
  assert.equal(rules.rules[1].id, "R02");
  assert.equal(rules.rules[2].id, "A01");
  assert.equal(rules.rules[2].category, "ai-redline");
});

test("架构师 Agent：内存模型产出故事圣经与书籍规则（合并红线）", async () => {
  const model = new MemoryModel({ responses: { architect_foundation: EXAMPLE_ARCHITECT_JSON } });
  const agent = new ArchitectAgent({ model });
  const bookConfig = buildBookConfig(EXAMPLE_DRAFT);
  const { storyBible, bookRules } = await agent.createStoryFoundation(BRIEF, EXAMPLE_DRAFT, bookConfig);
  assert.deepEqual(storyBible.sections, EXAMPLE_STORY_BIBLE.sections);
  assert.equal(bookRules.bookId, "yinlong");
  assert.equal(bookRules.rules.length, 7 + AI_REDLINES.length);
});

test("架构师 Agent：首次输出非法、重试后成功", async () => {
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      return calls === 1 ? JSON.stringify({ storyBible: [], bookRules: [] }) : EXAMPLE_ARCHITECT_JSON;
    },
  });
  const agent = new ArchitectAgent({ model });
  const bookConfig = buildBookConfig(EXAMPLE_DRAFT);
  const { storyBible } = await agent.createStoryFoundation(BRIEF, EXAMPLE_DRAFT, bookConfig);
  assert.equal(calls, 2);
  assert.equal(storyBible.sections.length, 6);
});

test("架构师 Agent：重试仍失败时抛出 ArchitectError", async () => {
  const model = new MemoryModel({ forceContent: "{}" });
  const agent = new ArchitectAgent({ model, maxRetries: 1 });
  const bookConfig = buildBookConfig(EXAMPLE_DRAFT);
  await assert.rejects(
    () => agent.createStoryFoundation(BRIEF, EXAMPLE_DRAFT, bookConfig),
    ArchitectError,
  );
});
