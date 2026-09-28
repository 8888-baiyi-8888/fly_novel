import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookId } from "../types";
import type { HookRecord } from "../types";
import { viewForChapter } from "../services/hook-ledger";

const H005 = "H005" as HookId;
const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const H014 = "H014" as HookId;
const H021 = "H021" as HookId;
const H023 = "H023" as HookId;
const H099 = "H099" as HookId;
const chapter = 21;
const totalChapters = 100;

/** §4.4/§7.7 示例伏笔 + 补充用例（H005 近期埋设、H021 可自主、H023 挂起、H099 非 coreHook 的 mustResolve）。 */
function makeLedger(): Readonly<Record<HookId, HookRecord>> {
  return {
    [H007]: { hookId: H007, startChapter: 2, type: "物件", status: "progressing", lastAdvancedChapter: 19, advancedCount: 1, expectedPayoff: "对赌反噬", payoffTiming: "mid-arc", coreHook: true },
    [H011]: { hookId: H011, startChapter: 5, type: "信息差", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "殿主称呼", payoffTiming: "slow-burn" },
    [H014]: { hookId: H014, startChapter: 6, type: "秘密", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "雨夜真相", payoffTiming: "endgame" },
    [H021]: { hookId: H021, startChapter: 18, type: "关系", status: "open", lastAdvancedChapter: 20, advancedCount: 1, expectedPayoff: "敬酒手抖", payoffTiming: "mid-arc" },
    [H023]: { hookId: H023, startChapter: 8, type: "秘密", status: "deferred", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "体检单", payoffTiming: "near-term" },
    [H099]: { hookId: H099, startChapter: 10, type: "身份", status: "progressing", lastAdvancedChapter: 20, advancedCount: 2, expectedPayoff: "旧印线索", payoffTiming: "mid-arc" },
  };
}

test("viewForChapter：H007（coreHook 且压力达 MUST）→ mustResolve + mustNotDefer，pressure 读数正确", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.ok(ctx.mustResolve.includes(H007));
  assert.ok(ctx.mustNotDefer.includes(H007)); // coreHook
  const p = ctx.pressure[H007];
  assert.equal(p.score, 49); // 30 + 5(progressing) + min(12,2*2) + 10(overdue)
  assert.equal(p.label, "MUST_RESOLVE");
  assert.equal(p.age, 19);
  assert.equal(p.dormancy, 2);
});

test("viewForChapter：H099（非 coreHook 但 MUST_RESOLVE）→ mustResolve 且 mustNotDefer（§4.3 不可 defer）", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.ok(ctx.mustResolve.includes(H099));
  assert.ok(ctx.mustNotDefer.includes(H099));
});

test("viewForChapter：H011（slow-burn 长期未动，ch21 opening 未 phaseReady）→ mustAdvance（压力公式行为）", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.ok(ctx.mustAdvance.includes(H011));
  assert.equal(ctx.pressure[H011].label, "MUST_ADVANCE");
  assert.equal(ctx.pressure[H011].score, 27); // 16 + 11
  assert.ok(!ctx.staleDebt.includes(H011)); // opening 阶段 slow-burn 未 phaseReady → 不 stale
});

test("viewForChapter：慢烧伏笔在 middle 阶段才 stale（ch35）→ staleDebt 登记", () => {
  const ctx = viewForChapter(makeLedger(), 35, { totalChapters });
  assert.ok(ctx.staleDebt.includes(H011)); // ch35 middle：slow-burn phaseReady 且 dormancy 25 ≥ 5
  assert.ok(ctx.mustAdvance.includes(H011));
});

test("viewForChapter：H021（ready 但未达 MUST）→ canResolve + SHOULD_RESOLVE", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.ok(ctx.canResolve.includes(H021));
  assert.equal(ctx.pressure[H021].label, "SHOULD_RESOLVE");
  assert.equal(ctx.pressure[H021].score, 32); // 30 + min(12,1*2)
  assert.ok(!ctx.mustResolve.includes(H021));
});

test("viewForChapter：H005 未达任何强制线 → canAdvance + label OK", () => {
  const ledger = { ...makeLedger(), [H005]: { hookId: H005, startChapter: 20, type: "承诺", status: "open", lastAdvancedChapter: 20, advancedCount: 0, expectedPayoff: "x", payoffTiming: "mid-arc" } };
  const ctx = viewForChapter(ledger, chapter, { totalChapters });
  assert.ok(ctx.canAdvance.includes(H005));
  assert.equal(ctx.pressure[H005].label, "OK");
  assert.equal(ctx.pressure[H005].score, 2); // age 1 + dormancy 1
  assert.ok(!ctx.mustAdvance.includes(H005));
});

test("viewForChapter：deferred 不发指令不进 pressure；activeCount 仍计入（未结清占预算）", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.ok(!ctx.mustAdvance.includes(H023));
  assert.ok(!ctx.canAdvance.includes(H023));
  assert.ok(!ctx.staleDebt.includes(H023));
  assert.equal(ctx.pressure[H023], undefined);
  assert.equal(ctx.budget.activeCount, 6); // H005 不在 fixture；6 条全部未 resolved
});

test("viewForChapter：resolved 不出现且不计入 activeCount", () => {
  const ledger = { ...makeLedger(), [H099]: { ...makeLedger()[H099]!, status: "resolved" } };
  const ctx = viewForChapter(ledger, chapter, { totalChapters });
  assert.ok(!ctx.mustResolve.includes(H099));
  assert.equal(ctx.pressure[H099], undefined);
  assert.equal(ctx.budget.activeCount, 5);
});

test("viewForChapter：budget——cap 默认 12 且 openAllowed；cap=6 时超限禁用开新", () => {
  const ctx = viewForChapter(makeLedger(), chapter, { totalChapters });
  assert.deepEqual(ctx.budget, { activeCount: 6, cap: 12, openAllowed: true });
  const tight = viewForChapter(makeLedger(), chapter, { totalChapters, cap: 6 });
  assert.equal(tight.budget.openAllowed, false);
});

test("viewForChapter：全部 resolved → 空指令、activeCount 0", () => {
  const empty = viewForChapter({}, chapter, { totalChapters });
  assert.deepEqual(empty.mustResolve, []);
  assert.deepEqual(empty.mustAdvance, []);
  assert.equal(empty.budget.activeCount, 0);
  assert.equal(empty.budget.openAllowed, true);
});
