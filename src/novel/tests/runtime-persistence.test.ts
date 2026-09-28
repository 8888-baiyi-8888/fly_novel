import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeDelta } from "../types/runtime-delta";
import { buildFakeBookRuntime } from "../runtime/fake-book-runtime";
import { H007, TL_MAIN } from "../runtime/fixtures";

/** H007 推进 delta（最后一章结算语义：时钟推进到 chapter）。 */
function advanceDelta(chapter: number, count: number): RuntimeDelta {
  return {
    facts: [],
    hookOps: [{ op: "advance", hookId: H007, how: "测试推进", to: "progressing", lastAdvancedChapter: chapter, advancedCount: count }],
    stateChanges: {},
  };
}

test("运行时快照：snapshot → restore 往返保持账本/真相/时钟/状态一致", () => {
  const a = buildFakeBookRuntime();
  const before = a.snapshot();
  const b = buildFakeBookRuntime();
  b.restore(before);
  assert.deepEqual(b.snapshot(), before);
  // 深拷贝：改 b 不影响 a
  b.restore({ ...b.snapshot(), ledger: { ...b.snapshot().ledger } });
  assert.deepEqual(b.snapshot().ledger, a.snapshot().ledger);
  const statesA = a.characterStates as Record<string, { goal?: string }>;
  const statesB = b.characterStates as Record<string, { goal?: string }>;
  assert.equal(statesB["叶凡"]?.goal, statesA["叶凡"]?.goal);
});

test("跨章演进：restore 后账本/时钟从上一章继续", () => {
  const a = buildFakeBookRuntime();
  // 第 1 章 settle：H007 advance
  const r1 = a.settleChapter(1, advanceDelta(1, 1));
  assert.equal(r1.kind, "applied");
  assert.equal(a.ledgerView[H007]?.status, "progressing");
  const snap = a.snapshot();

  // 新进程（run-chapter 每次启动的新实例）restore 上一章快照
  const b = buildFakeBookRuntime();
  b.restore(snap);
  assert.equal(b.ledgerView[H007]?.status, "progressing", "restore 后账本延续");
  // 时钟：第 1 章 advanceAll 后 tl-main-share 应已推进
  const tl = b.timeline.snapshotFor(0)[TL_MAIN];
  assert.ok(tl !== undefined && tl.syncPoint >= 1, `时钟应已推进到第 1 章，实际 ${tl?.syncPoint}`);

  // 第 2 章 settle：H007 继续推进（防回退：lastAdvancedChapter 只升不降；advancedCount 累加）
  const r2 = b.settleChapter(2, advanceDelta(2, 2));
  assert.equal(r2.kind, "applied");
  assert.ok(
    (b.ledgerView[H007]?.lastAdvancedChapter ?? 0) >= 19,
    "防回退：lastAdvancedChapter 不得低于开局值 19",
  );
  assert.equal(b.ledgerView[H007]?.advancedCount, 3, "每次 advance +1（开局 1 + 两章推进）");
  // 原实例 a 不受 b 影响（独立状态）
  assert.equal(a.ledgerView[H007]?.advancedCount, 2);
});
