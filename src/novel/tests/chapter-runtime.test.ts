import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CharacterName, Dispatch, EventId, HookContext, HookId, RuntimeDelta, SceneSheet, Simulation, ThreadId,
} from "../types";
import type { HookOp, SceneHookOp, SideInsertSlot } from "../types";

/* 编译期断言：运行时结构的可辨识联合与枚举字面量集合完整。 */
type Expect<T extends true> = T;
type _hookOpOps = Expect<[Exclude<HookOp["op"], "open" | "advance" | "resolve" | "defer" | "mention">] extends [never] ? true : false>;
type _sceneHookOps = Expect<[Exclude<SceneHookOp["op"], "open" | "advance" | "resolve" | "mention">] extends [never] ? true : false>;
type _sideSlotNoMiddle = Expect<("middle" extends SideInsertSlot ? false : true)>;

test("Dispatch：按 §5.2 构造（含 HookDirectives），字段齐备", () => {
  const dispatch: Dispatch = {
    chapter: 21,
    goal: "让江辰自己念出协议第三条，收束 H007，推进 H011",
    castPlan: [
      {
        name: "叶凡" as CharacterName, tier: "S", role: "main",
        directive: "沉默。等江辰念完第三条再开口。",
        agentQuery: "你签协议那天就打算留到这一刻吗？",
        hardLimits: ["不能对苏晴坦白", "不能提'龙王'"],
      },
      {
        name: "苏晴" as CharacterName, tier: "S", role: "main",
        directive: "列席董事局，第一次看清协议内容。",
        hardLimits: ["不能提前知道协议是叶凡拟的"],
      },
      { name: "江辰" as CharacterName, tier: "A", role: "support", directive: "推动董事会拿协议做文章。", hardLimits: [] },
      { name: "法务" as CharacterName, tier: "B", role: "cameo", directive: "逐条念协议。", hardLimits: [] },
    ],
    threadPlan: [
      { threadId: "tl-main-share" as ThreadId, eventIds: ["E-M07" as EventId], slot: "middle" },
      { threadId: "tl-side-wine" as ThreadId, eventIds: ["E-S03" as EventId], slot: "end" },
    ],
    hookDirectives: {
      open: [],
      advance: [{ hookId: "H011" as HookId, how: "给出真实新信息：老陈知道'殿主'称呼", to: "progressing" }],
      resolve: [{ hookId: "H007" as HookId, how: "回收：协议是叶凡自己拟的", echoFrom: "抚平放回抽屉最底层，四道折痕" }],
      defer: [],
      mention: [],
    },
    styleNotes: ["对话占比 65%", "叶凡台词总量 ≤20 字"],
    budget: { scenes: 3, chars: 2500 },
  };
  assert.equal(dispatch.castPlan.length, 4);
  assert.equal(dispatch.hookDirectives.resolve[0]?.hookId, "H007");
  assert.equal(dispatch.hookDirectives.resolve[0]?.echoFrom, "抚平放回抽屉最底层，四道折痕");
});

test("HookContext：按 §4.4 构造，强制项与预算齐备", () => {
  const hookContext: HookContext = {
    mustResolve: ["H007" as HookId],
    mustAdvance: ["H011" as HookId],
    canResolve: [],
    canAdvance: ["H019" as HookId],
    mustNotDefer: ["H007" as HookId],
    pressure: {
      ["H007" as HookId]: { score: 52, label: "resolve", age: 19, dormancy: 3 },
      ["H011" as HookId]: { score: 35, label: "advance", age: 16, dormancy: 11 },
    },
    staleDebt: ["H011" as HookId],
    budget: { activeCount: 7, cap: 12, openAllowed: true },
  };
  assert.deepEqual(hookContext.mustResolve, ["H007"]);
  assert.equal(hookContext.pressure["H007" as HookId]?.label, "resolve");
  assert.equal(hookContext.budget.openAllowed, true);
});

test("Simulation：按 §6 推导结构构造", () => {
  const simulation: Simulation = {
    character: "叶凡" as CharacterName,
    tier: "S",
    lines: ["念完了？", "一张废纸。"],
    actions: ["把笔放回笔筒，转了半圈"],
    suspects: ["苏晴已经开始怀疑这份协议与我有关"],
    reasoning: "她要看我慌，我偏不慌。",
    risk: "苏晴会以为我真的放弃了。",
  };
  assert.equal(simulation.character, "叶凡");
  assert.equal(simulation.lines.length, 2);
});

test("SceneSheet：按 §7.7 第 21 章拍摄单实例构造", () => {
  const sceneSheet: SceneSheet = {
    writingPlan: "本章在江氏季度董事会上收束 H007：让江辰自己念出协议第三条，念到一半停住。全章对话占比 65%，叶凡台词总量控制在 20 字以内。结尾用 H011 的新信息作为翻页钩。",
    scenes: [
      {
        no: 1, kind: "main", pov: "苏晴" as CharacterName, slot: "start",
        purpose: "建立赌局：江氏要拿离婚协议做文章，逼叶凡放弃江氏贸易 12% 股份",
        beats: ["会议室里江辰把协议复印件推到叶凡面前", "苏晴作为家属列席，第一次看清那份纸上的字", "法务逐条念，念到第三条时语速变快"],
        cast: ["苏晴" as CharacterName, "江辰" as CharacterName, "叶凡" as CharacterName, "法务" as CharacterName],
        material: {
          lines: ["苏晴：这纸……怎么折过四次？"],
          actions: ["叶凡把复印件转了个方向，正对江辰", "江辰的笑在某一瞬间凝固"],
          suspects: ["苏晴怀疑叶凡早就看过这份协议"],
        },
        hookOps: [{ hookId: "H007" as HookId, op: "advance", how: "苏晴注意到折痕——协议的物理特征第三次出现", echo: "四道折痕" }],
        budgetChars: 700, emotion: "压迫",
      },
      {
        no: 2, kind: "main", pov: "叶凡" as CharacterName, slot: "middle",
        purpose: "引爆：让江辰自己念出对赌条款",
        beats: ["法务念第三条", "叶凡不说话，等着", "江辰念完才反应过来"],
        cast: ["叶凡" as CharacterName, "江辰" as CharacterName, "法务" as CharacterName],
        material: { lines: ["叶凡：念完了？"], actions: ["叶凡把笔放回笔筒，转了半圈"], suspects: [] },
        hookOps: [{ hookId: "H007" as HookId, op: "resolve", echo: "四道折痕", how: "回收：协议是叶凡自己拟的条款" }],
        budgetChars: 1200, emotion: "释放·爽",
      },
      {
        no: 3, kind: "main", pov: "苏晴" as CharacterName, slot: "end",
        purpose: "推进 H011（陈旧债）并给钩子",
        beats: ["苏晴在停车场问叶凡那协议是不是他写的", "老陈拿出一瓶不摘标签的酒", "苏晴第一次看见老陈叫她'夫人'时眼睛是红的"],
        cast: ["苏晴" as CharacterName, "叶凡" as CharacterName, "老陈" as CharacterName],
        material: { lines: ["老陈：殿主，这瓶是那年留下的。"], actions: ["老陈倒酒时手抖，酒洒了一半"], suspects: ["苏晴确定'殿主'不是公司职称"] },
        hookOps: [
          { hookId: "H011" as HookId, op: "advance", how: "给出真实新信息：这瓶酒与'那年'有关", echo: "不摘标签的酒" },
          { hookId: "H007" as HookId, op: "mention", how: "苏晴把协议原件收进自己包里" },
        ],
        budgetChars: 600, emotion: "震动·悬念",
      },
    ],
    weavingNotes: "H007 的 resolve 放在第 2 场中段，不要在结尾——结尾要让给 H011 的 advance。",
    forbidden: ["叶凡本章不能对苏晴坦白任何事", "不能出现'龙王'二字", "老陈不能解释酒的含义"],
  };
  assert.equal(sceneSheet.scenes.length, 3);
  assert.equal(sceneSheet.scenes[1]?.hookOps[0]?.op, "resolve");
  assert.equal(sceneSheet.scenes[2]?.hookOps.length, 2);
  assert.equal(sceneSheet.forbidden.length, 3);
});

test("RuntimeDelta：按 §11.1 三类 delta 构造", () => {
  const delta: RuntimeDelta = {
    facts: [
      { subject: "江氏贸易股权", subjectType: "item", predicate: "属于", object: "叶凡", knownBy: ["叶凡" as CharacterName, "江辰" as CharacterName] },
      { subject: "老陈", subjectType: "character", predicate: "知道称呼", object: "殿主", knownBy: ["老陈" as CharacterName, "苏晴" as CharacterName] },
    ],
    hookOps: [
      { op: "advance", hookId: "H011" as HookId, how: "老陈倒酒说出'殿主'", to: "progressing", lastAdvancedChapter: 21, advancedCount: 2 },
      { op: "resolve", hookId: "H007" as HookId, how: "对赌条款反噬江氏", echoFrom: "四道折痕" },
    ],
    stateChanges: {
      ["苏晴" as CharacterName]: { location: "江氏停车场", emotion: "震动", suspects: ["'殿主'不是公司职称"] },
    },
  };
  assert.equal(delta.facts.length, 2);
  assert.equal(delta.hookOps[0]?.op, "advance");
  if (delta.hookOps[0]?.op === "advance") {
    assert.equal(delta.hookOps[0].lastAdvancedChapter, 21);
  }
  assert.deepEqual(delta.stateChanges["苏晴" as CharacterName]?.suspects, ["'殿主'不是公司职称"]);
});
