import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookId, HookOp } from "../types";
import type { HookRecord } from "../types";
import { validateApplyDelta } from "../gates/apply-delta-gate";
import type { ApplyDeltaRule } from "../gates/apply-delta-gate";
import { mergeHookOps } from "../services/hook-ledger";

const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const H014 = "H014" as HookId;
const H027 = "H027" as HookId;
const H032 = "H032" as HookId;
const H999 = "H999" as HookId;
const chapter = 21;
const totalChapters = 100;

/** 账本：H007（mid-arc progressing 已 ready）、H011（slow-burn open 不 ready）、H032（ready 但 dependsOn 未 resolved）。 */
function makeLedger(): Readonly<Record<HookId, HookRecord>> {
  return {
    [H007]: { hookId: H007, startChapter: 2, type: "物件", status: "progressing", lastAdvancedChapter: 19, advancedCount: 1, expectedPayoff: "对赌反噬", payoffTiming: "mid-arc" },
    [H011]: { hookId: H011, startChapter: 5, type: "信息差", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "殿主称呼", payoffTiming: "slow-burn" },
    [H014]: { hookId: H014, startChapter: 6, type: "秘密", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "雨夜真相", payoffTiming: "endgame" },
    [H027]: { hookId: H027, startChapter: 27, type: "身份", status: "open", lastAdvancedChapter: 27, advancedCount: 1, expectedPayoff: "刻龙旧印", payoffTiming: "slow-burn" },
    // ③ 校验只看 readyToResolve：H032 造为 ready（mid-arc progressing 且 dormancy≤1），使 ④ 依赖校验成为唯一违规项
    [H032]: { hookId: H032, startChapter: 2, type: "身份", status: "progressing", lastAdvancedChapter: 20, advancedCount: 1, expectedPayoff: "龙王身份", payoffTiming: "mid-arc", dependsOn: [H027] },
  };
}

function resolveOp(hookId: HookId): HookOp {
  return { op: "resolve", hookId, how: "回收", echoFrom: "原文摘录" };
}
function advanceOp(hookId: HookId): HookOp {
  return { op: "advance", hookId, how: "新信息", to: "progressing", lastAdvancedChapter: chapter, advancedCount: 2 };
}
function mentionOp(hookId: HookId): HookOp {
  return { op: "mention", hookId };
}

test("通过：ready 的 resolve + advance + mention 全部放行", () => {
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [resolveOp(H007), advanceOp(H011), mentionOp(H011)] });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  assert.equal(verdict.ops.length, 3);
  assert.equal(verdict.warnings.length, 0);
});

test("① schema：字段类型错误（advance.to 非法 / 负数 advancedCount / 未知 op）→ 整批拒绝", () => {
  const bad1 = { op: "advance", hookId: H011, how: "x", to: "resolved", lastAdvancedChapter: 21, advancedCount: 2 } as unknown as HookOp;
  assert.deepEqual(validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [bad1] }).kind, "rejected-batch");
  const bad2 = { op: "advance", hookId: H011, how: "x", to: "progressing", lastAdvancedChapter: -1, advancedCount: 2 } as unknown as HookOp;
  const v2 = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [bad2] });
  assert.equal(v2.kind, "rejected-batch");
  if (v2.kind === "rejected-batch") assert.equal(v2.rule, "schema");
  const bad3 = { op: "explode", hookId: H011 } as unknown as HookOp;
  const v3 = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [bad3] });
  assert.equal(v3.kind, "rejected-batch");
  if (v3.kind === "rejected-batch") assert.equal(v3.rule, "schema");
});

test("② ID：resolve 引用账本中不存在的 hookId → 整批拒绝", () => {
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [resolveOp(H999)] });
  assert.equal(verdict.kind, "rejected-batch");
  if (verdict.kind === "rejected-batch") {
    assert.equal(verdict.rule, "unknown-hook");
    assert.equal(verdict.violations[0]?.hookId, H999);
  }
});

test("③ 语义：resolve 未 ready（H014 endgame 在 middle 阶段）→ 降级为 advance + warning", () => {
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [resolveOp(H014)] });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  assert.equal(verdict.warnings.length, 1);
  assert.equal(verdict.warnings[0]?.rule, "resolve-not-ready");
  const degraded = verdict.ops[0];
  assert.equal(degraded?.op, "advance");
  if (degraded?.op === "advance") {
    assert.equal(degraded.hookId, H014);
    assert.equal(degraded.to, "progressing");
  }
});

test("④ 依赖：resolve H032 时 dependsOn（H027）未 resolved → 拒绝该条，其余放行", () => {
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [resolveOp(H032), advanceOp(H011)] });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  assert.equal(verdict.warnings.length, 1);
  assert.equal(verdict.warnings[0]?.rule, "resolve-dependency-blocked");
  assert.deepEqual(verdict.ops.map((o) => o.op), ["advance"]); // H032 的 resolve 被剔除
});

test("⑤ 时点：resolvableAt 不含 H007 → 拒绝该条", () => {
  const verdict = validateApplyDelta({
    chapter, totalChapters, ledger: makeLedger(),
    ops: [resolveOp(H007)],
    resolvableAt: new Set<HookId>([H011]),
  });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  assert.equal(verdict.warnings[0]?.rule, "resolve-unreachable");
  assert.equal(verdict.ops.length, 0);
});

test("多违规聚合：两条 resolve 同时不 ready → warnings 齐全", () => {
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger: makeLedger(), ops: [resolveOp(H014), resolveOp(H011)] });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  assert.equal(verdict.warnings.length, 2);
  assert.ok(verdict.warnings.every((w) => w.rule === "resolve-not-ready"));
  assert.deepEqual(verdict.ops.map((o) => o.op), ["advance", "advance"]);
});

test("六步链路：校验通过 → mergeHookOps 合并后账本状态正确（H007 resolved / H011 progressing）", () => {
  const ledger = makeLedger();
  const verdict = validateApplyDelta({ chapter, totalChapters, ledger, ops: [resolveOp(H007), advanceOp(H011)] });
  assert.equal(verdict.kind, "accepted");
  if (verdict.kind !== "accepted") return;
  const merged = mergeHookOps({ ledger, ops: verdict.ops, chapter });
  assert.equal(merged.ledger[H007]?.status, "resolved");
  assert.equal(merged.ledger[H011]?.status, "progressing");
  assert.equal(merged.ledger[H011]?.lastAdvancedChapter, 21);
  assert.equal(merged.skipped.length, 0);
});
