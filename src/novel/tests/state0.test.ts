import { test } from "node:test";
import assert from "node:assert/strict";

import { State0Agent, validateHookSeedsAgainstBeatBoard } from "../state0";
import { EXAMPLE_STATE0_JSON, EXAMPLE_STATE0 } from "../state0/example";
import { MemoryModel } from "../../harness/adapters/models/memory-model";

import { EXAMPLE_ARCHITECTURE_JSON, EXAMPLE_BEAT_BOARD_JSON } from "../architecture/example";
import { ArchitectureAgent, StoryArchitectAgent, DirectorAgent } from "../architecture";
import { EXAMPLE_ARCHITECTURE } from "../architecture/example";
import { ControlsAgent } from "../controls";
import { CreativeDraftAgent, EXAMPLE_RAW_INPUT, EXAMPLE_DRAFT } from "../draft";
import { ArchitectAgent } from "../architect";

import { buildBookConfig } from "../book-config";
import { buildCreativeBrief } from "../architect";

/** 复用 N1 的 EXAMPLE_DRAFT：返回《隐龙》草案对象。 */
function draft() {
  return EXAMPLE_DRAFT;
}

/** 用预置响应组装一个 memory 版 ArchitectureAgent（N5）。 */
function architectureAgent(): ArchitectureAgent {
  const architect = new StoryArchitectAgent({
    model: new MemoryModel({ responses: { story_architecture: EXAMPLE_ARCHITECTURE_JSON } }),
  });
  const director = new DirectorAgent({
    model: new MemoryModel({ responses: { beat_board: EXAMPLE_BEAT_BOARD_JSON } }),
  });
  return new ArchitectureAgent(architect, director);
}

/** 用预置响应组装一个 memory 版 ArchitectAgent（N3）。 */
function architectAgent(): ArchitectAgent {
  const model = new MemoryModel({
    responses: {
      story_foundation: JSON.stringify(EXAMPLE_ARCHITECTURE_JSON),
    },
  });
  return new ArchitectAgent({ model });
}

/** 用预置响应组装一个 memory 版 ControlsAgent（N4）。 */
function controlsAgent(): ControlsAgent {
  const model = new MemoryModel({
    responses: {
      controls: JSON.stringify({
        schemaVersion: 4,
        authorIntent: "信息差爽点",
        currentFocus: ["离婚协议逼签"],
        volumeDirections: ["第一卷借势反噬"],
        constraints: ["不虐主", "不送女"],
      }),
    },
  });
  return new ControlsAgent({ model });
}

/** 用预置响应组装一个 memory 版 CreativeDraftAgent（N1）。 */
function draftAgent(): CreativeDraftAgent {
  return new CreativeDraftAgent({
    model: new MemoryModel({ responses: { creative_draft: EXAMPLE_ARCHITECTURE_JSON } }),
  });
}

function state0Agent(): State0Agent {
  const model = new MemoryModel({ responses: { state0: EXAMPLE_STATE0_JSON } });
  return new State0Agent({ model });
}

test("N6 State₀：六类结构齐全且 bookId/title 与输入一致", async () => {
  const agent = state0Agent();
  const architecture = await architectureAgent().createArchitecture({
    draft: draft(),
    storyBible: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
    bookRules: { bookId: "yinlong", title: "隐龙", rules: [] },
    controls: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
  });
  const state0 = await agent.createState0(architecture);
  assert.equal(state0.bookId, architecture.bookId);
  assert.equal(state0.title, architecture.title);
  assert.ok(Array.isArray(state0.characterStates));
  assert.ok(Array.isArray(state0.relationshipStates));
  assert.ok(Array.isArray(state0.worldState));
  assert.ok(Array.isArray(state0.hookSeeds));
  assert.ok(Array.isArray(state0.threadBoard));
  assert.equal(state0.progressState.currentChapter, 0);
});

test("N6 State₀：伏笔种子过准入闸门（type 非空 + expectedPayoff 或 notes 至少一个）", () => {
  const seeds = EXAMPLE_STATE0.hookSeeds;
  for (const seed of seeds) {
    assert.ok(typeof seed.type === "string" && seed.type.length > 0, `种子 ${seed.hookId} 缺 type`);
    assert.ok(
      (typeof seed.expectedPayoff === "number" && seed.expectedPayoff > 0) ||
        (typeof seed.notes === "string" && seed.notes.length > 0),
      `种子 ${seed.hookId} 缺 expectedPayoff 或 notes`,
    );
  }
});

test("N6 State₀：伏笔种子数量不超过最大活跃 12", () => {
  assert.ok(EXAMPLE_STATE0.hookSeeds.length <= 12);
});

test("N6 State₀：档位配比偏差在容差内（示例 near-term +10 个百分点，允许 warning）", () => {
  const seeds = EXAMPLE_STATE0.hookSeeds;
  const total = seeds.length;
  assert.ok(total > 0);
  const counts: Record<string, number> = {};
  for (const seed of seeds) {
    counts[seed.timing] = (counts[seed.timing] ?? 0) + 1;
  }
  const pct = (key: string) => ((counts[key] ?? 0) / total) * 100;
  assert.equal(pct("immediate"), 0);
  assert.equal(pct("near-term"), 40);
  assert.equal(pct("mid-arc"), 20);
  assert.equal(pct("slow-burn"), 20);
  assert.equal(pct("endgame"), 20);
});

test("N6 State₀：threadBoard 的 lineId 必须落在叙事线地图内（M/S1/F1 都在示例里）", () => {
  const lineIds = new Set(EXAMPLE_STATE0.threadBoard.map((t) => t.lineId));
  assert.ok(lineIds.has("M"));
  assert.ok(lineIds.has("S1"));
});

test("N6 State₀：characterStates 里的角色与 N5 角色卡同名（叶凡/苏晴/赵芳/老陈）", () => {
  const names = new Set(EXAMPLE_STATE0.characterStates.map((c) => c.name));
  assert.ok(names.has("叶凡"));
  assert.ok(names.has("苏晴"));
  assert.ok(names.has("赵芳"));
  assert.ok(names.has("老陈"));
});

test("N6 State₀：progressState.currentChapter 必须是 0（故事还没开写）", () => {
  assert.equal(EXAMPLE_STATE0.progressState.currentChapter, 0);
  assert.equal(EXAMPLE_STATE0.progressState.stage, "故事开端");
});

test("N6 State₀：MemoryModel 响应可被 State0Agent 正确解析（端到端）", async () => {
  const agent = state0Agent();
  const architecture = await architectureAgent().createArchitecture({
    draft: draft(),
    storyBible: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
    bookRules: { bookId: "yinlong", title: "隐龙", rules: [] },
    controls: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
  });
  const state0 = await agent.createState0(architecture);
  assert.equal(state0.hookSeeds.length, 5);
  assert.equal(state0.threadBoard.length, 3);
  assert.deepEqual(state0.progressState.completedEvents, []);
});

test("N6 上下文接续：N5 五件套（含节拍板）是 N6 唯一输入，不依赖 N1 原始文本", async () => {
  const agent = state0Agent();
  const architecture = await architectureAgent().createArchitecture({
    draft: draft(),
    storyBible: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
    bookRules: { bookId: "yinlong", title: "隐龙", rules: [] },
    controls: JSON.parse(EXAMPLE_ARCHITECTURE_JSON),
  });
  const state0 = await agent.createState0(architecture);
  // N6 输出必须携带 bookId，供后续 N7 持久化定位
  assert.ok(state0.bookId.length > 0);
});

test("N6 对账：示例种子的 beatTag 在节拍板里都有埋有收（能回收才入账）", () => {
  const beats = EXAMPLE_ARCHITECTURE.beatBoard.beats;
  const violations = validateHookSeedsAgainstBeatBoard(EXAMPLE_STATE0.hookSeeds, beats);
  assert.deepEqual(violations, [], `示例种子应全部通过节拍板对账，实际违规：${violations.join("；")}`);
});

test("N6 对账：beatTag 在节拍板里找不到（凭空编造）→ 拒绝入账", () => {
  const beats = EXAMPLE_ARCHITECTURE.beatBoard.beats;
  const fake = [
    {
      ...EXAMPLE_STATE0.hookSeeds[0],
      hookId: "H999",
      beatTag: "ch999-h1",
    },
  ];
  const violations = validateHookSeedsAgainstBeatBoard(fake, beats);
  assert.ok(violations.length > 0);
  assert.ok(violations[0].includes("凭空编造"));
});

test("N6 对账：只埋不收的 beatTag → 拒绝入账", () => {
  // 手工构造一个只埋不收回的节拍板：ch1 埋 ch10-h1，但没有任何章 plannedPayoffOf 引用它
  const beats = [
    { chapter: 1, hookIntentions: ["【ch10-h1】只埋不收的钩子"], plannedPayoffOf: [] },
  ];
  const seeds = [
    { ...EXAMPLE_STATE0.hookSeeds[0], hookId: "H888", beatTag: "ch10-h1", plantedChapter: 1 },
  ];
  const violations = validateHookSeedsAgainstBeatBoard(seeds, beats);
  assert.ok(violations.length > 0);
  assert.ok(violations[0].includes("只埋不收"));
});

test("N6 对账：回收章不在埋设章之后 → 拒绝入账", () => {
  // 埋设 ch10、回收却写 ch5（回收早于埋设）→ 拒绝
  const beats = [
    { chapter: 10, hookIntentions: ["【ch10-h1】伏笔"], plannedPayoffOf: [] },
    { chapter: 5, hookIntentions: [], plannedPayoffOf: ["ch10-h1"] },
  ];
  const seeds = [
    { ...EXAMPLE_STATE0.hookSeeds[0], hookId: "H777", beatTag: "ch10-h1", plantedChapter: 1 },
  ];
  const violations = validateHookSeedsAgainstBeatBoard(seeds, beats);
  assert.ok(violations.length > 0);
  assert.ok(violations[0].includes("回收章"));
});
