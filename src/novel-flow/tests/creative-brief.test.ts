import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreativeBrief } from "../architect/creative-brief";
import { EXAMPLE_DRAFT } from "../draft/example";

test("创作简报：包含书名/题材/平台/篇幅", () => {
  const brief = buildCreativeBrief(EXAMPLE_DRAFT);
  assert.ok(brief.includes("《隐龙》"));
  assert.ok(brief.includes("都市"));
  assert.ok(brief.includes("番茄"));
  assert.ok(brief.includes("100 章"));
  assert.ok(brief.includes("2500 字"));
});

test("创作简报：包含一句话故事/核心卖点/约束/作者意图", () => {
  const brief = buildCreativeBrief(EXAMPLE_DRAFT);
  assert.ok(brief.includes("一句话故事："));
  assert.ok(brief.includes("龙王殿殿主叶凡隐姓埋名入赘"));
  assert.ok(brief.includes("核心卖点："));
  assert.ok(brief.includes("作者特别在意："));
  assert.ok(brief.includes("不虐主"));
  assert.ok(brief.includes("作者意图："));
});
