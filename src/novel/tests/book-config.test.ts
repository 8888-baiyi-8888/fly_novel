import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookConfig, slugifyTitle } from "../book-config/book-config";
import { normalizeGenre, normalizePlatform } from "../book-config/mapping";
import { EXAMPLE_DRAFT } from "../draft/example";

test("slugifyTitle：中文书名转拼音小写", () => {
  assert.equal(slugifyTitle("隐龙"), "yinlong");
  assert.equal(slugifyTitle("林小满"), "linxiaoman");
});

test("slugifyTitle：数字/字母保留，特殊符号剔除", () => {
  // 注："重"是多音字，pinyin-pro 按词频默认读 chong（重复的重），bookId 为内部标识，接受默认读音
  assert.equal(slugifyTitle("重生2010"), "chongsheng2010");
  assert.equal(slugifyTitle("斗破苍穹3"), "doupocangqiong3");
});

test("slugifyTitle：纯符号标题回退 book", () => {
  assert.equal(slugifyTitle("!!!"), "book");
});

test("normalizeGenre：保留第一个非空题材原文", () => {
  assert.equal(normalizeGenre(["都市", "隐龙流"]), "都市");
  assert.equal(normalizeGenre(["百合", "职场"]), "百合");
});

test("normalizeGenre：全部为空返回 未定", () => {
  assert.equal(normalizeGenre(["  ", ""]), "未定");
  assert.equal(normalizeGenre([]), "未定");
});

test("normalizePlatform：保留平台原文", () => {
  assert.equal(normalizePlatform("番茄"), "番茄");
  assert.equal(normalizePlatform(" 起点 "), "起点");
});

test("normalizePlatform：空串返回 未定", () => {
  assert.equal(normalizePlatform("   "), "未定");
});

test("buildBookConfig：从草案运行参数固化书籍配置", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const config = buildBookConfig(EXAMPLE_DRAFT, now);
  assert.equal(config.bookId, "yinlong");
  assert.equal(config.title, "隐龙");
  assert.equal(config.genre, "都市");
  assert.equal(config.platform, "番茄");
  assert.equal(config.targetChapters, 100);
  assert.equal(config.chapterWordCount, 2500);
  assert.equal(config.language, "zh");
});

test("buildBookConfig：默认值 chapterReviewMode/maxHookRetries", () => {
  const config = buildBookConfig(EXAMPLE_DRAFT);
  assert.equal(config.chapterReviewMode, "auto");
  assert.equal(config.maxHookRetries, 2);
});

test("buildBookConfig：时间戳字段", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const config = buildBookConfig(EXAMPLE_DRAFT, now);
  assert.equal(config.createdAt, now.toISOString());
  assert.equal(config.updatedAt, now.toISOString());
});

test("buildBookConfig：同一草案生成确定性 bookId", () => {
  const a = buildBookConfig(EXAMPLE_DRAFT);
  const b = buildBookConfig(EXAMPLE_DRAFT);
  assert.equal(a.bookId, b.bookId);
});
