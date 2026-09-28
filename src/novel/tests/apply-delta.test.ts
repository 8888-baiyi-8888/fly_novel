import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookId, HookOp } from "../types";
import type { HookRecord } from "../types";
import { applyDeltaPure } from "../services/apply-delta";

const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const H014 = "H014" as HookId;
const H027 = "H027" as HookId;
const H032 = "H032" as HookId;
const chapter = 21;
const totalChapters = 100;

/** 与 apply-delta-gate 测试同构的账本（H007 ready / H011 不 ready / H032 依赖阻塞）。 */
function makeLedger(): Readonly<Record<HookId, HookRecord>> {
  return {
    [H007]: { hookId: H007, startChapter: 2, type: "物件", status: "progressing", lastAdvancedChapter: 19, advancedCount: 1, expectedPayoff: "对赌反噬", payoffTiming: "mid-arc" },
    [H011]: { hookId: H011, startChapter: 5, type: "信息差", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "殿主称呼", payoffTiming: "slow-burn" },
    [H014]: { hookId: H014, startChapter: 6, type: "秘密", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "雨夜真相", payoffTiming: "endgame" },
    [H027]: { hookId: H027, startChapter: 27, type: "身份", status: "open", lastAdvancedChapter: 27, advancedCount: 1, expectedPayoff: "刻龙旧印", payoffTiming: "slow-burn" },
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
function openOp(): HookOp {
  return { op: "open", type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "埋设原文" };
}

test("applyDeltaPure：合法 ops → applied，新账本状态正确（resolve/advance/open/mention）且原账本不可变", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp(H007), advanceOp(H011), mentionOp(H011), openOp()] });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.ledger[H007]?.status, "resolved");
  assert.equal(result.ledger[H011]?.status, "progressing");
  assert.equal(result.ledger[H011]?.lastAdvancedChapter, 21);
  const added = Object.values(result.ledger).find((r) => r.hookId === "H033");
  assert.ok(added && added.status === "open" && added.startChapter === 21);
  assert.deepEqual(result.touched, [H011]);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.skipped.length, 0);
  // 不可变：原账本未被修改
  assert.equal(ledger[H007]?.status, "progressing");
  assert.equal(ledger[H011]?.lastAdvancedChapter, 10);
});

test("applyDeltaPure：schema 违规 → rejected-batch，原账本引用原样返回（状态不变）", () => {
  const ledger = makeLedger();
  const bad = { op: "advance", hookId: H011, how: "x", to: "resolved", lastAdvancedChapter: 21, advancedCount: 2 } as unknown as HookOp;
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [bad] });
  assert.equal(result.kind, "rejected-batch");
  if (result.kind === "rejected-batch") {
    assert.equal(result.rule, "schema");
    assert.equal(result.ledger, ledger); // 同一引用
  }
});

test("applyDeltaPure：unknown-hook → rejected-batch，原账本不变", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp("H999" as HookId)] });
  assert.equal(result.kind, "rejected-batch");
  if (result.kind === "rejected-batch") {
    assert.equal(result.rule, "unknown-hook");
    assert.equal(result.ledger, ledger);
  }
});

test("applyDeltaPure：③ 降级链路——endgame 未 ready 的 resolve 合并后成为推进", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp(H014)] });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.warnings[0]?.rule, "resolve-not-ready");
  assert.equal(result.ledger[H014]?.status, "progressing"); // 降级为 advance 的效果
  assert.equal(result.ledger[H014]?.lastAdvancedChapter, 21);
});

test("applyDeltaPure：④ 依赖阻塞——被拒的 resolve 不落账（H032 仍 progressing）", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp(H032)] });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.warnings[0]?.rule, "resolve-dependency-blocked");
  assert.equal(result.ledger[H032]?.status, "progressing"); // 未被 resolve
});

test("applyDeltaPure：⑤ 时间线不可达——被拒的 resolve 不落账", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp(H007)], resolvableAt: new Set<HookId>([H011]) });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.warnings[0]?.rule, "resolve-unreachable");
  assert.equal(result.ledger[H007]?.status, "progressing");
});

test("applyDeltaPure：混合批——部分拒绝/降级 + 部分通过，互不影响", () => {
  const ledger = makeLedger();
  const result = applyDeltaPure({ chapter, totalChapters, ledger, ops: [resolveOp(H007), resolveOp(H014), resolveOp(H032)] });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.ledger[H007]?.status, "resolved"); // 通过
  assert.equal(result.ledger[H014]?.status, "progressing"); // ③ 降级
  assert.equal(result.ledger[H032]?.status, "progressing"); // ④ 拒绝
  assert.deepEqual(result.warnings.map((w) => w.rule).sort(), ["resolve-dependency-blocked", "resolve-not-ready"]);
});
