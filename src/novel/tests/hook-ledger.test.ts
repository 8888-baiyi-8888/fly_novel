import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookId, HookTiming } from "../types";
import type { HookRecord } from "../types";
import { admitHookCandidate, bookPhase, lifecycle, mergeHookOps } from "../services/hook-ledger";
import type { HookOp } from "../types";

const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const H023 = "H023" as HookId;
const H032 = "H032" as HookId;

function hook(overrides: Partial<HookRecord>): HookRecord {
  return {
    hookId: H007,
    startChapter: 2,
    type: "物件",
    status: "progressing",
    lastAdvancedChapter: 19,
    advancedCount: 1,
    expectedPayoff: "对赌条款反噬江氏分公司",
    payoffTiming: "mid-arc",
    ...overrides,
  };
}

function op(opKind: HookOp["op"], overrides: Record<string, unknown> = {}): HookOp {
  const rest = overrides as Record<string, unknown>;
  switch (opKind) {
    case "open":
      return { op: "open", type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "埋设原文", ...rest };
    case "advance":
      return { op: "advance", hookId: H011, how: "新信息", to: "progressing", lastAdvancedChapter: 21, advancedCount: 2, ...rest };
    case "resolve":
      return { op: "resolve", hookId: H007, how: "回收", echoFrom: "四道折痕", ...rest };
    case "defer":
      return { op: "defer", hookId: H023, reason: "待铺垫", untilChapter: 34, ...rest };
    case "mention":
      return { op: "mention", hookId: H011, ...rest };
  }
}

test("bookPhase：按全书进度分阶段（0.33 / 0.72 边界）", () => {
  assert.equal(bookPhase(1, 100), "opening");
  assert.equal(bookPhase(33, 100), "middle");
  assert.equal(bookPhase(32, 100), "opening");
  assert.equal(bookPhase(72, 100), "late");
  assert.equal(bookPhase(71, 100), "middle");
});

test("lifecycle：mid-arc progressing 伏笔（§7.7 H007，ch21/100）→ readyToResolve", () => {
  const r = lifecycle(hook({}), 21, 100);
  assert.equal(r.age, 19);
  assert.equal(r.dormancy, 2);
  assert.equal(r.overdue, true); // age 19 ≥ mid-arc overdueAge 8
  assert.equal(r.stale, false); // progressing 且 recentlyTouched 不满足 stale 的 overdue 分支
  assert.equal(r.readyToResolve, true);
  assert.ok(r.resolvePressure >= 40, "resolvePressure 应达到 MUST_RESOLVE 线");
});

test("lifecycle：endgame 伏笔在 middle 阶段不 ready（§7.7 H014 示例）", () => {
  const r = lifecycle(hook({ payoffTiming: "endgame", status: "open", startChapter: 6, lastAdvancedChapter: 10 }), 21, 100);
  assert.equal(r.readyToResolve, false);
  assert.equal(r.resolvePressure, 0);
});

test("lifecycle：slow-burn 长期未动（H011 ch35/100 middle 阶段）→ stale 且不 ready", () => {
  const r = lifecycle(
    hook({ hookId: H011, payoffTiming: "slow-burn", status: "open", startChapter: 5, lastAdvancedChapter: 10 }),
    35,
    100,
  );
  assert.equal(bookPhase(35, 100), "middle"); // slow-burn 的最低书阶段是 middle
  assert.equal(r.dormancy, 25);
  assert.equal(r.stale, true); // dormancy 25 ≥ slow-burn staleDormancy 5
  assert.equal(r.readyToResolve, false); // open 且未 recentlyTouched
  assert.ok(r.advancePressure >= 8, "advancePressure 应达到 MUST_ADVANCE 线");
});

test("lifecycle：recentlyTouched 的伏笔不 stale（dormancy ≤ 1）", () => {
  const r = lifecycle(hook({ lastAdvancedChapter: 20 }), 21, 100);
  assert.equal(r.dormancy, 1);
  assert.equal(r.stale, false);
});

test("admitHookCandidate：准入两条硬规则（§10.4）", () => {
  assert.deepEqual(admitHookCandidate({ type: "", expectedPayoff: "x" }), { passed: false, reasons: ["type 必须非空"] });
  assert.deepEqual(admitHookCandidate({ type: "秘密" }), {
    passed: false,
    reasons: ["expectedPayoff 与 notes 至少一个非空"],
  });
  assert.deepEqual(admitHookCandidate({ type: "秘密", notes: "只有摘录" }), { passed: true });
  assert.deepEqual(admitHookCandidate({ type: "秘密", expectedPayoff: "x" }), { passed: true });
});

test("mergeHookOps：advance 合并（lastAdvancedChapter=max、advancedCount+1、status→progressing）且原账本不可变", () => {
  const ledger = { [H011]: hook({ hookId: H011, payoffTiming: "slow-burn", status: "open", startChapter: 5, lastAdvancedChapter: 10, advancedCount: 1 }) };
  const out = mergeHookOps({ ledger, ops: [op("advance", { lastAdvancedChapter: 21, advancedCount: 2 })], chapter: 21 });
  assert.equal(out.ledger[H011]?.lastAdvancedChapter, 21);
  assert.equal(out.ledger[H011]?.advancedCount, 2);
  assert.equal(out.ledger[H011]?.status, "progressing");
  assert.equal(out.skipped.length, 0);
  // 不可变：原账本未被修改
  assert.equal(ledger[H011]?.lastAdvancedChapter, 10);
  assert.equal(ledger[H011]?.status, "open");
});

test("mergeHookOps：advance 防回退——Settler 上报更小值时仍取 max(旧, 本章)", () => {
  const ledger = { [H011]: hook({ hookId: H011, status: "progressing", startChapter: 5, lastAdvancedChapter: 30, advancedCount: 3 }) };
  const out = mergeHookOps({ ledger, ops: [op("advance", { lastAdvancedChapter: 21, advancedCount: 1 })], chapter: 21 });
  assert.equal(out.ledger[H011]?.lastAdvancedChapter, 30); // max(30, 21)
  assert.equal(out.ledger[H011]?.advancedCount, 4); // max(旧+1, 上报)
});

test("mergeHookOps：resolve → resolved；mention 不动账本只登记 touched", () => {
  const ledger = { [H007]: hook({}) };
  const out = mergeHookOps({ ledger, ops: [op("resolve"), op("mention", { hookId: H011 })], chapter: 21 });
  assert.equal(out.ledger[H007]?.status, "resolved");
  assert.deepEqual(out.touched, [H011]);
  assert.equal(out.ledger[H011], undefined);
});

test("mergeHookOps：open 新增记录（新编号、startChapter=本章、notes=echoHint）", () => {
  const ledger = { [H007]: hook({}) };
  const out = mergeHookOps({ ledger, ops: [op("open")], chapter: 21 });
  const added = Object.values(out.ledger).find((r) => r.hookId !== H007);
  assert.ok(added);
  assert.equal(added.hookId, "H008" as HookId);
  assert.equal(added.startChapter, 21);
  assert.equal(added.status, "open");
  assert.equal(added.notes, "埋设原文");
});

test("mergeHookOps：coreHook 不得 defer（跳过 + skipped 登记）", () => {
  const ledger = { [H007]: hook({ coreHook: true }) };
  const out = mergeHookOps({ ledger, ops: [op("defer", { hookId: H007 })], chapter: 21 });
  assert.equal(out.ledger[H007]?.status, "progressing");
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0]?.reason ?? "", /coreHook/);
});

test("mergeHookOps：progressing 持续推进合法（保持 status、更新计数）", () => {
  const ledger = { [H007]: hook({}) }; // progressing
  const out = mergeHookOps({ ledger, ops: [op("advance", { hookId: H007 })], chapter: 21 });
  assert.equal(out.ledger[H007]?.status, "progressing");
  assert.equal(out.ledger[H007]?.lastAdvancedChapter, 21);
  assert.equal(out.ledger[H007]?.advancedCount, 2); // 旧 1 + 1
  assert.equal(out.skipped.length, 0);
});

test("mergeHookOps：advance 已 resolved 伏笔 → 跳过（resolved 终态不可推进）", () => {
  const ledger = { [H007]: hook({ status: "resolved" }) };
  const out = mergeHookOps({ ledger, ops: [op("advance", { hookId: H007 })], chapter: 21 });
  assert.equal(out.ledger[H007]?.status, "resolved");
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0]?.reason ?? "", /只允许 open\/progressing/);
});

test("mergeHookOps：H032 依赖链（dependsOn 前置未 resolved 时 resolve 被 ④ 拒——见闸门；此处验证合并侧正常接受 resolved 状态）", () => {
  const ledger = {
    [H007]: hook({}),
    [H032]: hook({ hookId: H032, status: "open", startChapter: 60, lastAdvancedChapter: 60, dependsOn: [H007] }),
  };
  const out = mergeHookOps({ ledger, ops: [op("resolve", { hookId: H032 })], chapter: 21 });
  // 依赖校验在闸门层；合并层只做状态迁移
  assert.equal(out.ledger[H032]?.status, "resolved");
});

test("lifecycle：H032 endgame（ch72/100 late 且最近被推进）→ readyToResolve", () => {
  const r = lifecycle(
    hook({ hookId: H032, payoffTiming: "endgame", status: "open", startChapter: 60, lastAdvancedChapter: 71 }),
    72,
    100,
  );
  assert.equal(bookPhase(72, 100), "late");
  assert.equal(r.dormancy, 1); // recentlyTouched
  assert.equal(r.readyToResolve, true);
});
