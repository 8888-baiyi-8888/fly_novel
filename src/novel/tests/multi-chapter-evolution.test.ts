import assert from "node:assert/strict";
import { test } from "node:test";
import type { CharacterName, HookId } from "../types";
import type { RuntimeDelta } from "../types";
import { buildFakeBookRuntime } from "../runtime/fake-book-runtime";
import { H007, H011, H014, H021, H023, TL_FLASHBACK_RAIN, TL_MAIN } from "../runtime/fixtures";

/**
 * 跨章连续 settle 验证（模拟层要支撑的核心场景）：
 * 同一 BookRuntime 实例上连续 settle 4 章，验证账本 / 真相 / 时钟跨章演变。
 * 场景：H007（ch21 resolve）、H011（slow-burn 全程降级推进）、H021（ch24 resolve）、
 * 新 open 自动编号 H024、闪回线 active（时钟推进 → §9.2 可达性翻转）、dormant 线不动。
 */

const N = "苏晴" as CharacterName;
const J = "江辰" as CharacterName;
const L = "老陈" as CharacterName;

/** 每章 delta 由"本章正文反推"而来（对应 Settler 产物）。 */
function chapterDelta(chapter: number, ops: RuntimeDelta["hookOps"]): RuntimeDelta {
  return { facts: [], hookOps: ops, stateChanges: { [N]: { location: `地点-${chapter}`, emotion: "平静" } } };
}

function advance(hookId: HookId, how: string, advancedCount: number): RuntimeDelta["hookOps"][number] {
  return { op: "advance", hookId, how, to: "progressing", lastAdvancedChapter: 0, advancedCount }; // lastAdvancedChapter 由合并取 max 防回退
}

function multiChapterRuntime() {
  return buildFakeBookRuntime({
    ledger: {
      [H007]: { hookId: H007, startChapter: 2, type: "物件", status: "progressing", lastAdvancedChapter: 19, advancedCount: 1, expectedPayoff: "对赌反噬", payoffTiming: "mid-arc", coreHook: true },
      [H011]: { hookId: H011, startChapter: 5, type: "信息差", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "殿主称呼", payoffTiming: "slow-burn" },
      [H014]: { hookId: H014, startChapter: 6, type: "秘密", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "雨夜真相", payoffTiming: "endgame" },
      [H021]: { hookId: H021, startChapter: 16, type: "关系", status: "open", lastAdvancedChapter: 18, advancedCount: 1, expectedPayoff: "电话内容", payoffTiming: "near-term" },
      [H023]: { hookId: H023, startChapter: 8, type: "秘密", status: "deferred", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "体检单", payoffTiming: "near-term" },
    },
    // 闪回线 active 但时钟落后（syncPoint 3）：用于演示时钟推进 → canReach 翻转
    threads: [
      { threadId: TL_MAIN, kind: "main", title: "江氏主线", status: "active", priority: 10, syncPoint: 21, speed: 1, eventChain: [], characters: [N, J] },
      { threadId: TL_FLASHBACK_RAIN, kind: "flashback", title: "雨夜", status: "active", priority: 3, syncPoint: 3, speed: 0.3, eventChain: [], characters: [N] },
    ],
  });
}

test("跨章：4 章连续 settle —— 账本演变（resolve 结清 / 降级推进 / 自动编号 / deferred 挂起）", () => {
  const runtime = multiChapterRuntime();
  const H024 = "H024" as HookId;

  // ch21：resolve H007 + advance H011 + open（自动编号 H024）
  const r21 = runtime.settleChapter(21, {
    ...chapterDelta(21, [
      advance(H011, "老陈倒酒", 2),
      { op: "resolve", hookId: H007, how: "对赌反噬", echoFrom: "四道折痕" },
      { op: "open", type: "物件", description: "酒瓶来历", payoffTiming: "mid-arc", expectedPayoff: "酒瓶与老陈的关系", echoHint: "那瓶酒" },
    ]),
    facts: [{ subject: "老陈", subjectType: "character", predicate: "给出", object: "酒瓶", knownBy: [L, N] }],
  });
  assert.equal(r21.kind, "applied");
  assert.equal(runtime.ledgerView[H007]?.status, "resolved"); // 结清
  assert.equal(runtime.ledgerView[H011]?.status, "progressing"); // 推进
  assert.equal(runtime.ledgerView[H024]?.status, "open"); // 自动编号
  assert.equal(runtime.ledgerView[H024]?.startChapter, 21);

  // ch22：advance H011 + advance H021（open→progressing）
  const r22 = runtime.settleChapter(22, chapterDelta(22, [advance(H011, "老陈提'殿主'", 3), advance(H021, "江辰第二次来电", 2)]));
  assert.equal(r22.kind, "applied");
  assert.equal(runtime.ledgerView[H011]?.lastAdvancedChapter, 22); // 防回退：max(旧, 本章)
  assert.equal(runtime.ledgerView[H011]?.advancedCount, 3);
  assert.equal(runtime.ledgerView[H021]?.status, "progressing");

  // ch23：resolve H011 → slow-burn 未 phaseReady（opening）→ 降级为 advance + warning
  const r23 = runtime.settleChapter(23, chapterDelta(23, [advance(H011, "老陈说出'殿主'", 4), { op: "resolve", hookId: H011, how: "称呼揭晓", echoFrom: "殿主" }, advance(H024, "酒瓶摆上桌", 1)]));
  assert.equal(r23.kind, "applied");
  assert.ok(r23.warnings.some((w) => w.message.includes("降级") || w.message.includes("ready")));
  assert.equal(runtime.ledgerView[H011]?.status, "progressing"); // 未 resolve
  assert.equal(runtime.ledgerView[H024]?.status, "progressing");

  // ch24：resolve H021（near-term 已 ready）+ advance H011
  const r24 = runtime.settleChapter(24, chapterDelta(24, [advance(H011, "老陈醉酒", 5), { op: "resolve", hookId: H021, how: "电话内容揭晓", echoFrom: "第二次电话" }]));
  assert.equal(r24.kind, "applied");
  assert.equal(runtime.ledgerView[H021]?.status, "resolved");

  // 跨章视图：resolved 的 H007/H021 不再产生指令；deferred 的 H023 始终挂起不产生指令
  const view24 = runtime.ledger.viewForChapter(24);
  assert.ok(!view24.mustResolve.includes(H007));
  assert.ok(!view24.mustResolve.includes(H021));
  assert.ok(!view24.mustAdvance.includes(H007));
  assert.ok(!view24.mustAdvance.includes(H023));
  // H011 持续有压力（age 大）→ 仍 mustAdvance；H014 endgame 同
  assert.ok(view24.mustAdvance.includes(H011));
  // H023 deferred → 不在任何指令集
  assert.ok(!view24.canResolve.includes(H023) && !view24.canAdvance.includes(H023));
});

test("跨章：真相演变 —— facts 按章累积、factId/validFrom 与写入章一致、knownBy 信息差隔离", () => {
  const runtime = multiChapterRuntime();

  runtime.settleChapter(21, {
    ...chapterDelta(21, [advance(H011, "老陈倒酒", 2)]),
    facts: [{ subject: "老陈", subjectType: "character", predicate: "给出", object: "酒瓶", knownBy: [L, N] }],
  });
  runtime.settleChapter(22, {
    ...chapterDelta(22, [advance(H011, "老陈提殿主", 3)]),
    facts: [{ subject: "江辰", subjectType: "character", predicate: "通话内容", object: "对赌条款", knownBy: [J] }],
  });
  runtime.settleChapter(23, chapterDelta(23, [advance(H011, "老陈说出殿主", 4)]));
  runtime.settleChapter(24, {
    ...chapterDelta(24, [advance(H011, "老陈醉酒", 5)]),
    facts: [{ subject: "苏晴", subjectType: "character", predicate: "获知", object: "酒瓶与协议有关", knownBy: [N] }],
  });

  const all = runtime.truth.snapshot(24, []).facts;
  assert.deepEqual(all.map((f) => f.factId), ["F001", "F002", "F003", "F004"]); // 累积 + 递增
  assert.equal(all[1]?.validFromChapter, 21);
  assert.equal(all[2]?.validFromChapter, 22);
  assert.equal(all[3]?.validFromChapter, 24);
  assert.equal(all[3]?.sourceChapter, 24);

  // 信息差：苏晴知道 F001/F002/F004，不知道江辰的 F003
  const su = runtime.truth.knowledgeOf(N, 24);
  assert.deepEqual(su.map((f) => f.factId).sort(), ["F001", "F002", "F004"]);
  // 章过滤：ch21 时 F002 可见、F003 尚未写入
  const at21 = runtime.truth.snapshot(21, []).facts;
  assert.deepEqual(at21.map((f) => f.factId), ["F001", "F002"]);
});

test("跨章：时钟演变 —— active 线随章推进、canReach 翻转；dormant 线不动、H014 始终不可达", () => {
  // active 闪回线：syncPoint 3 → 每章 settle 后推进 → ch21 起 H014 可达（§9.2 时钟推进）
  const runtime = multiChapterRuntime();
  assert.equal(runtime.timeline.canReach(TL_FLASHBACK_RAIN, H014, 21), false); // 时钟未推进前不可达
  runtime.settleChapter(21, chapterDelta(21, [advance(H011, "老陈倒酒", 2)]));
  assert.equal(runtime.timeline.snapshotFor(21)[TL_FLASHBACK_RAIN]?.syncPoint, 21);
  assert.equal(runtime.timeline.canReach(TL_FLASHBACK_RAIN, H014, 21), true); // 推进 → 可达翻转
  runtime.settleChapter(22, chapterDelta(22, [advance(H011, "老陈提殿主", 3)]));
  assert.equal(runtime.timeline.snapshotFor(22)[TL_MAIN]?.syncPoint, 22);

  // dormant 线：默认 fixture 的闪回线不动，settle 后 syncPoint 仍 3，H014 恒不可达
  const dormant = buildFakeBookRuntime(); // 默认：tl-flashback-rain dormant syncPoint 3
  dormant.settleChapter(21, chapterDelta(21, [advance(H011, "老陈倒酒", 2)]));
  dormant.settleChapter(22, chapterDelta(22, [advance(H011, "老陈提殿主", 3)]));
  assert.equal(dormant.timeline.snapshotFor(22)[TL_FLASHBACK_RAIN]?.syncPoint, 3);
  assert.equal(dormant.timeline.canReach(TL_FLASHBACK_RAIN, H014, 22), false);
});

test("跨章：§9.2 时点可达闭环 —— 同一条 ready 伏笔，归属线未推进时 resolve 被⑤拒绝，推进后放行", () => {
  // 第一步：把 H021 推进到 ready 状态（progressing + recentlyTouched）
  const run = (hookToThread: Partial<Record<string, string>>) => {
    const runtime = buildFakeBookRuntime({
      ledger: {
        [H021]: { hookId: H021, startChapter: 16, type: "关系", status: "open", lastAdvancedChapter: 18, advancedCount: 1, expectedPayoff: "电话内容", payoffTiming: "near-term" },
      },
      hookToThread: hookToThread as never,
    });
    const r20 = runtime.settleChapter(20, chapterDelta(20, [advance(H021, "第一次电话", 2)]));
    assert.equal(r20.kind, "applied"); // advance 不查时点（只有 resolve 查）
    assert.equal(runtime.ledgerView[H021]?.status, "progressing");
    const r21 = runtime.settleChapter(21, chapterDelta(21, [{ op: "resolve", hookId: H021, how: "电话内容揭晓", echoFrom: "第二次电话" }]));
    assert.equal(r21.kind, "applied");
    return { runtime, r21 };
  };

  // A：H021 归属闪回线（dormant，syncPoint 3 未推进）→ resolve 被 ⑤ 拒绝（warning，非致命）
  const a = run({ [H021]: TL_FLASHBACK_RAIN });
  assert.ok(a.r21.warnings.some((w) => w.rule === "resolve-unreachable"));
  assert.equal(a.runtime.ledgerView[H021]?.status, "progressing"); // 未结清

  // B：H021 归属主线（active，syncPoint 已推进）→ resolve 放行
  const b = run({ [H021]: TL_MAIN });
  assert.ok(!b.r21.warnings.some((w) => w.rule === "resolve-unreachable"));
  assert.equal(b.runtime.ledgerView[H021]?.status, "resolved");
});

test("跨章：不可变与原子 —— 每章 settle 只更新账本副本，旧视图引用不被修改；rejected 时全状态不变", () => {
  const runtime = multiChapterRuntime();
  const before21 = runtime.ledgerView; // 引用捕获
  const r21 = runtime.settleChapter(21, chapterDelta(21, [advance(H011, "老陈倒酒", 2)]));
  assert.equal(r21.kind, "applied");
  assert.equal(before21[H011]?.status, "open"); // 旧引用未被修改（不可变）
  assert.equal(runtime.ledgerView[H011]?.status, "progressing");

  // rejected 章：resolve 不存在 hook + 上一章已推进的状态全部保持
  const beforeBad = runtime.ledgerView;
  const factsBefore = runtime.truth.snapshot(22, []).facts.length;
  const bad = runtime.settleChapter(22, {
    ...chapterDelta(22, [{ op: "resolve", hookId: "H999" as HookId, how: "x", echoFrom: "x" }]),
  });
  assert.equal(bad.kind, "rejected-batch");
  assert.deepEqual(runtime.ledgerView, beforeBad); // 账本不变
  assert.equal(runtime.truth.snapshot(22, []).facts.length, factsBefore); // 真相不变
  assert.equal(runtime.characterStates[N]?.location, "地点-21"); // 状态停在上一章
});
