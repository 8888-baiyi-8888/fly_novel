import test from "node:test";
import assert from "node:assert/strict";

import { MemoryModel } from "../../harness/adapters/models/memory-model";
import {
  ArchitectureAgent,
  ArchitectureValidationError,
  DirectorAgent,
  DirectorError,
  extractHookTag,
  parseArchitectureOutput,
  parseBeatBoardOutput,
  StoryArchitectAgent,
  validateBeatBoard,
} from "../architecture";
import { EXAMPLE_ARCHITECTURE, EXAMPLE_ARCHITECTURE_JSON, EXAMPLE_BEAT_BOARD_JSON } from "../architecture/example";
import { Beat, BeatBoard } from "../architecture/types";
import { EXAMPLE_DRAFT_JSON } from "../draft/example";
import { CreativeDraftAgent } from "../draft/creative-draft-agent";
import { CreativeDraft } from "../draft/types";
import { EXAMPLE_STORY_BIBLE, buildExampleBookRules } from "../architect/example";
import { EXAMPLE_CONTROLS } from "../controls/example";
import { ControlsAgent } from "../controls";

/** 生成《隐龙》示例草案（内存版）。 */
async function exampleDraft(): Promise<CreativeDraft> {
  const agent = new CreativeDraftAgent({
    model: new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } }),
  });
  return agent.createDraft(EXAMPLE_DRAFT_JSON);
}

test("architecture：合法前四件可解析", () => {
  const parsed = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  assert.equal(parsed.storyFrame.protagonistPath.length, 5);
  assert.equal(parsed.volumeMap.length, 3);
  assert.equal(parsed.characterCards.length, 4);
  assert.equal(parsed.characterCards[0].tier, "S");
  assert.equal(parsed.threadMap.lines.length, 3);
});

test("architecture：缺 storyFrame 抛校验错误", () => {
  assert.throws(
    () =>
      parseArchitectureOutput({
        volumeMap: [{ volume: "第一卷", title: "t", goal: "g", stages: ["s"] }],
        characterCards: [],
        threadMap: { lines: [] },
      }),
    ArchitectureValidationError,
  );
});

test("architecture：tier 非法值抛校验错误", () => {
  const base = JSON.parse(EXAMPLE_ARCHITECTURE_JSON);
  const bad = structuredClone(base);
  bad.characterCards[0].tier = "C";
  assert.throws(() => parseArchitectureOutput(bad), ArchitectureValidationError);
});

test("architecture：汇合事件 requires 长度 ≥2 且 merge=true（示例 E-S103）", () => {
  const parsed = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  const mergeEvent = parsed.threadMap.lines
    .flatMap((line) => line.events)
    .find((ev) => ev.merge === true);
  assert.ok(mergeEvent !== undefined);
  assert.ok((mergeEvent?.requires.length ?? 0) >= 2);
});

test("architecture：合法节拍板可解析且过验收闸门", () => {
  const parsed = parseBeatBoardOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON).beatBoard, 100);
  assert.equal(parsed.beats.length, 100);
  const violations = validateBeatBoard(parsed, 100);
  assert.deepEqual(violations, []);
});

test("architecture：mainBeat 超 60 字 → 验收闸门拦截", () => {
  const beats: Beat[] = Array.from({ length: 100 }, (_, i) => ({
    chapter: i + 1,
    title: `ch${i + 1}`,
    mainBeat: "这是一个特别特别长的主线大事描述".repeat(5) + "超长了",
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: [],
    plannedPayoffOf: [],
  }));
  const violations = validateBeatBoard({ beats }, 100);
  assert.ok(violations.some((v) => v.includes("超 60 字")));
});

test("architecture：相邻 3 章全「释放」→ 验收闸门拦截", () => {
  const beats: Beat[] = Array.from({ length: 5 }, (_, i) => ({
    chapter: i + 1,
    title: `ch${i + 1}`,
    mainBeat: `第 ${i + 1} 章主事件`,
    characters: [],
    threadId: "M",
    pacing: (i === 1 || i === 2 || i === 3 ? "释放" : "铺垫") as Beat["pacing"],
    emotionalArc: "x",
    hookIntentions: [],
    plannedPayoffOf: [],
  }));
  const violations = validateBeatBoard({ beats }, 5);
  assert.ok(violations.some((v) => v.includes("连续 3 章")));
});

test("architecture：伏笔密度低于 0.2 → 验收闸门拦截", () => {
  const beats: Beat[] = Array.from({ length: 100 }, (_, i) => ({
    chapter: i + 1,
    title: `ch${i + 1}`,
    mainBeat: `第 ${i + 1} 章主事件`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: i === 0 ? ["【ch1-h1】伏笔一"] : [],
    plannedPayoffOf: i === 2 ? ["ch1-h1"] : [],
  }));
  const violations = validateBeatBoard({ beats }, 100);
  assert.ok(violations.some((v) => v.includes("密度")));
});

test("architecture：hook tag 无回收 → 验收闸门拦截", () => {
  const beats: Beat[] = Array.from({ length: 100 }, (_, i) => ({
    chapter: i + 1,
    title: `ch${i + 1}`,
    mainBeat: `第 ${i + 1} 章主事件`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: i === 0 ? ["【ch1-h1】伏笔一"] : [],
    plannedPayoffOf: [],
  }));
  const violations = validateBeatBoard({ beats }, 100);
  assert.ok(violations.some((v) => v.includes("只埋不收")));
});

test("architecture：hookIntention 缺 tag 前缀 → 验收闸门拦截", () => {
  const beats: Beat[] = Array.from({ length: 100 }, (_, i) => ({
    chapter: i + 1,
    title: `ch${i + 1}`,
    mainBeat: `第 ${i + 1} 章主事件`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: i === 0 ? ["没有 tag 的伏笔"] : [],
    plannedPayoffOf: [],
  }));
  const violations = validateBeatBoard({ beats }, 100);
  assert.ok(violations.some((v) => v.includes("缺少 tag")));
});

test("architecture：extractHookTag 解析【tag】前缀", () => {
  assert.equal(extractHookTag("【ch2-h1】协议要留折痕"), "ch2-h1");
  assert.equal(extractHookTag("没有前缀的文本"), null);
});

test("architecture：MemoryModel 前四件返回《隐龙》结构", async () => {
  const draft = await exampleDraft();
  const architect = new StoryArchitectAgent({
    model: new MemoryModel({ responses: { story_architecture: EXAMPLE_ARCHITECTURE_JSON } }),
  });
  const parts = await architect.createParts({
    draft,
    storyBible: EXAMPLE_STORY_BIBLE,
    bookRules: buildExampleBookRules(),
    controls: EXAMPLE_CONTROLS,
  });
  assert.equal(parts.storyFrame.coreConflict.includes("信息差"), true);
});

test("architecture：MemoryModel Director 节拍板过验收闸门", async () => {
  const draft = await exampleDraft();
  const director = new DirectorAgent({
    model: new MemoryModel({ responses: { beat_board: EXAMPLE_BEAT_BOARD_JSON } }),
  });
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  const board: BeatBoard = await director.createBeatBoard(draft, parts);
  assert.equal(board.beats.length, 100);
});

test("architecture：全链路 Agent（前四件 → 节拍板）产出五件套", async () => {
  const draft = await exampleDraft();
  const architect = new StoryArchitectAgent({
    model: new MemoryModel({ responses: { story_architecture: EXAMPLE_ARCHITECTURE_JSON } }),
  });
  const director = new DirectorAgent({
    model: new MemoryModel({ responses: { beat_board: EXAMPLE_BEAT_BOARD_JSON } }),
  });
  const agent = new ArchitectureAgent(architect, director);
  const result = await agent.createArchitecture({
    draft,
    storyBible: EXAMPLE_STORY_BIBLE,
    bookRules: buildExampleBookRules(),
    controls: EXAMPLE_CONTROLS,
  });
  assert.equal(result.bookId, "yinlong");
  assert.equal(result.beatBoard.beats.length, 100);
});

test("architecture：Director 输出违反闸门 → 重试带反馈 → 成功", async () => {
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        // 第一次：密度为 0 的非法节拍板（beats 为空数组，根结构为 { beats }）
        return JSON.stringify({ beats: [] });
      }
      return EXAMPLE_BEAT_BOARD_JSON;
    },
  });
  const director = new DirectorAgent({ model, maxRetries: 1 });
  const draft = await exampleDraft();
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  const board = await director.createBeatBoard(draft, parts);
  assert.equal(calls, 2);
  assert.equal(board.beats.length, 100);
});

test("architecture：多次重试仍违规 → 抛 DirectorError", async () => {
  const model = new MemoryModel({
    responder: () => JSON.stringify({ beats: [] }),
  });
  const director = new DirectorAgent({ model, maxRetries: 1 });
  const draft = await exampleDraft();
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  await assert.rejects(() => director.createBeatBoard(draft, parts), DirectorError);
});

test("architecture：示例五件套与解析结果一致", () => {
  assert.equal(EXAMPLE_ARCHITECTURE.bookId, "yinlong");
  assert.equal(EXAMPLE_ARCHITECTURE.volumeMap[1].title, "重聚");
  assert.equal(EXAMPLE_ARCHITECTURE.characterCards[0].secret.includes("龙王殿殿主"), true);
});


