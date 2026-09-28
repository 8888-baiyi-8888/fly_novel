import test from "node:test";
import assert from "node:assert/strict";

import { MemoryModel } from "../adapters/memory-model";
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

// ---------- N5 分块生成（B+C 方案）：planBeatChunks / mergeChunkBeats / 分块 Director ----------

import { mergeChunkBeats, planBeatChunks, volumeNumber } from "../architecture/chunk";

test("architecture/chunk：volumeNumber 兼容「第一卷/第1卷/第三卷」", () => {
  assert.equal(volumeNumber("第一卷"), 1);
  assert.equal(volumeNumber("第1卷"), 1);
  assert.equal(volumeNumber("第三卷"), 3);
  assert.equal(volumeNumber("卷末"), null);
});

test("architecture/chunk：100 章 3 卷均分 → 34/33/33，首尾相连", () => {
  const volumes = [
    { volume: "第一卷", title: "t1", goal: "g1", stages: ["s"] },
    { volume: "第二卷", title: "t2", goal: "g2", stages: ["s"] },
    { volume: "第三卷", title: "t3", goal: "g3", stages: ["s"] },
  ];
  const chunks = planBeatChunks(100, volumes);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => [c.startChapter, c.endChapter]), [
    [1, 34],
    [35, 67],
    [68, 100],
  ]);
});

test("architecture/chunk：150 章 4 卷均分 → 38/38/37/37，首尾相连", () => {
  const volumes = Array.from({ length: 4 }, (_, i) => ({
    volume: `第${i + 1}卷`,
    title: `t${i + 1}`,
    goal: `g${i + 1}`,
    stages: ["s"],
  }));
  const chunks = planBeatChunks(150, volumes);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((c) => [c.startChapter, c.endChapter]), [
    [1, 38],
    [39, 76],
    [77, 113],
    [114, 150],
  ]);
  assert.ok(chunks.every((c) => c.endChapter - c.startChapter + 1 <= 40));
});

test("architecture/chunk：100 章 2 卷（每卷 50 章）→ 每卷拆 25/25，共 4 块且每块 ≤40", () => {
  const volumes = Array.from({ length: 2 }, (_, i) => ({
    volume: `第${i + 1}卷`,
    title: `t${i + 1}`,
    goal: `g${i + 1}`,
    stages: ["s"],
  }));
  const chunks = planBeatChunks(100, volumes);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((c) => c.id), ["V1-1", "V1-2", "V2-1", "V2-2"]);
  assert.deepEqual(chunks.map((c) => [c.startChapter, c.endChapter]), [
    [1, 25],
    [26, 50],
    [51, 75],
    [76, 100],
  ]);
});

test("architecture/chunk：合并后全局章号连续且保持块顺序", () => {
  const volumes = Array.from({ length: 2 }, (_, i) => ({
    volume: `第${i + 1}卷`,
    title: `t${i + 1}`,
    goal: `g${i + 1}`,
    stages: ["s"],
  }));
  const chunks = planBeatChunks(10, volumes);
  const chunk1: Beat[] = Array.from({ length: 5 }, (_, i) => ({
    chapter: i + 1,
    title: `c${i + 1}`,
    mainBeat: `块1 第${i + 1}章`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: [],
    plannedPayoffOf: [],
  }));
  const chunk2: Beat[] = Array.from({ length: 5 }, (_, i) => ({
    chapter: i + 1,
    title: `c${i + 1}`,
    mainBeat: `块2 第${i + 1}章`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: [],
    plannedPayoffOf: [],
  }));
  const merged = mergeChunkBeats(chunks, [chunk1, chunk2]);
  assert.deepEqual(merged.beats.map((b) => b.chapter), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(merged.beats[5].mainBeat, "块2 第1章");
});

/** 构造合法全书节拍板：每 5 章埋 1 伏笔（密度 0.2）、3 章后回收；30 章版。 */
function makeLegitBeats(chapters: number): Beat[] {
  const beats: Beat[] = [];
  for (let i = 1; i <= chapters; i += 1) {
    const hookIntentions: string[] = [];
    const plannedPayoffOf: string[] = [];
    if (i % 5 === 1) {
      hookIntentions.push(`【ch${i}-h1】第 ${i} 章埋设伏笔`);
    }
    if (i % 5 === 4) {
      plannedPayoffOf.push(`ch${i - 3}-h1`);
    }
    beats.push({
      chapter: i,
      title: `ch${i}`,
      mainBeat: `第 ${i} 章主事件`,
      characters: [],
      threadId: "M",
      pacing: i % 4 === 0 ? "释放" : "铺垫",
      emotionalArc: "x",
      hookIntentions,
      plannedPayoffOf,
    });
  }
  return beats;
}

test("architecture：chunked Director 分块生成 → 合并 → 全书闸门通过", async () => {
  const draft = await exampleDraft();
  draft.targetChapters = 30;
  const full = makeLegitBeats(30);
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      const slice = full.slice((calls - 1) * 10, calls * 10);
      const chunkBeats = slice.map((b) => ({ ...b, chapter: b.chapter - (calls - 1) * 10 }));
      return JSON.stringify({ beats: chunkBeats });
    },
  });
  const director = new DirectorAgent({ model, chunked: true });
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  const board = await director.createBeatBoard(draft, parts);
  assert.equal(calls, 3); // 3 卷 → 3 块
  assert.equal(board.beats.length, 30);
  assert.equal(board.beats[0].chapter, 1);
  assert.equal(board.beats[29].chapter, 30);
  const violations = validateBeatBoard(board, 30);
  assert.deepEqual(violations, []);
});

test("architecture：chunked Director 块内输出长度错误 → 块内重试 → 成功", async () => {
  const draft = await exampleDraft();
  draft.targetChapters = 30;
  const full = makeLegitBeats(30);
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        // 第一块第一次：只给 5 条（块应为 10 条）→ 触发块内重试
        return JSON.stringify({ beats: full.slice(0, 5).map((b) => ({ ...b, chapter: b.chapter })) });
      }
      const blockIndex = calls <= 2 ? 0 : calls - 2; // calls=2 → 块0 重试；calls=3 → 块1；calls=4 → 块2
      const slice = full.slice(blockIndex * 10, blockIndex * 10 + 10);
      const chunkBeats = slice.map((b) => ({ ...b, chapter: b.chapter - blockIndex * 10 }));
      return JSON.stringify({ beats: chunkBeats });
    },
  });
  const director = new DirectorAgent({ model, chunked: true });
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  const board = await director.createBeatBoard(draft, parts);
  assert.equal(calls, 4); // 块0 重试 1 次 + 块1 + 块2
  assert.equal(board.beats.length, 30);
});

test("architecture：chunked Director 合并后全书校验失败（只埋不收）→ 抛 DirectorError", async () => {
  const draft = await exampleDraft();
  draft.targetChapters = 30;
  const bad = makeLegitBeats(30);
  // 最后一章的回收移除 → ch1-h1 等只剩埋设？改为：删掉所有 plannedPayoffOf → 只埋不收
  for (const b of bad) {
    b.plannedPayoffOf = [];
  }
  let calls = 0;
  const model = new MemoryModel({
    responder: () => {
      calls += 1;
      const slice = bad.slice((calls - 1) * 10, calls * 10);
      return JSON.stringify({ beats: slice.map((b) => ({ ...b, chapter: b.chapter - (calls - 1) * 10 })) });
    },
  });
  const director = new DirectorAgent({ model, chunked: true });
  const parts = parseArchitectureOutput(JSON.parse(EXAMPLE_ARCHITECTURE_JSON));
  await assert.rejects(() => director.createBeatBoard(draft, parts), DirectorError);
  assert.equal(calls, 3);
});

test("architecture/chunk：合并时 hook tag 与 payoff 引用按块内号重编号为全局号", () => {
  const volumes = [
    { volume: "第一卷", title: "t1", goal: "g1", stages: ["s"] },
    { volume: "第二卷", title: "t2", goal: "g2", stages: ["s"] },
  ];
  const chunks = planBeatChunks(20, volumes); // 10 + 10
  const makeBeat = (ch: number, hooks: string[], payoffs: string[]): Beat => ({
    chapter: ch,
    title: `c${ch}`,
    mainBeat: `第 ${ch} 章事件`,
    characters: [],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "x",
    hookIntentions: hooks,
    plannedPayoffOf: payoffs,
  });
  // 块 1：块内 ch1 埋【ch1-h1】（全局 ch1）；块 2：块内 ch1 埋【ch1-h1】（全局 ch11）、块内 ch9 回收
  const chunk1: Beat[] = Array.from({ length: 10 }, (_, i) =>
    makeBeat(i + 1, i === 0 ? ["【ch1-h1】第一块伏笔"] : [], []),
  );
  const chunk2: Beat[] = Array.from({ length: 10 }, (_, i) =>
    makeBeat(i + 1, i === 0 ? ["【ch1-h1】第二块伏笔"] : [], i === 8 ? ["ch1-h1"] : []),
  );
  const merged = mergeChunkBeats(chunks, [chunk1, chunk2]);
  // 块 1：ch1 的 tag 保持 ch1-h1；块 2：块内 ch1 → 全局 ch11，payoff 同步
  assert.equal(merged.beats[0].hookIntentions[0], "【ch1-h1】第一块伏笔");
  assert.equal(merged.beats[10].hookIntentions[0], "【ch11-h1】第二块伏笔");
  assert.deepEqual(merged.beats[18].plannedPayoffOf, ["ch11-h1"]);
  // 重编号后不再撞车：两个不同内容各占 ch1-h1 / ch11-h1
  assert.notEqual(merged.beats[0].hookIntentions[0], merged.beats[10].hookIntentions[0]);
});

test("architecture：同 tag 被多条不同伏笔共用 → 验收闸门拦截", () => {
  const beats: Beat[] = [
    {
      chapter: 1, title: "c1", mainBeat: "第一章", characters: [], threadId: "M",
      pacing: "铺垫", emotionalArc: "x", hookIntentions: ["【ch1-h1】剪报伏笔"], plannedPayoffOf: [],
    },
    {
      chapter: 2, title: "c2", mainBeat: "第二章", characters: [], threadId: "M",
      pacing: "铺垫", emotionalArc: "x", hookIntentions: [], plannedPayoffOf: ["ch1-h1"],
    },
    {
      chapter: 3, title: "c3", mainBeat: "第三章", characters: [], threadId: "M",
      pacing: "铺垫", emotionalArc: "x", hookIntentions: ["【ch1-h1】数据异常伏笔"], plannedPayoffOf: ["ch1-h1"],
    },
  ];
  const violations = validateBeatBoard({ beats }, 3);
  assert.ok(violations.some((v) => v.includes("共用")));
});

test("architecture：plannedPayoffOf 引用未埋设的 tag（孤儿回收）→ 验收闸门拦截", () => {
  const beats: Beat[] = [
    {
      chapter: 1, title: "c1", mainBeat: "第一章", characters: [], threadId: "M",
      pacing: "铺垫", emotionalArc: "x", hookIntentions: ["【ch1-h1】真实伏笔"], plannedPayoffOf: [],
    },
    {
      chapter: 2, title: "c2", mainBeat: "第二章", characters: [], threadId: "M",
      pacing: "铺垫", emotionalArc: "x", hookIntentions: [], plannedPayoffOf: ["ch1-h1", "ch99-h9"],
    },
  ];
  const violations = validateBeatBoard({ beats }, 2);
  assert.ok(violations.some((v) => v.includes("孤儿回收")));
});


