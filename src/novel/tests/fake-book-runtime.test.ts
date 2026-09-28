import assert from "node:assert/strict";
import { test } from "node:test";
import type { CharacterName, FactId, HookId } from "../types";
import type { RuntimeDelta } from "../types";
import { buildFakeBookRuntime } from "../runtime/fake-book-runtime";
import { H007, H011, H014, TL_FLASHBACK_RAIN, TL_MAIN } from "../runtime/fixtures";

const chapter = 21;

function deltaFixture(): RuntimeDelta {
  return {
    facts: [{ subject: "老陈", subjectType: "character", predicate: "给出称呼", object: "殿主", knownBy: ["老陈" as CharacterName, "苏晴" as CharacterName] }],
    hookOps: [
      { op: "advance", hookId: H011, how: "老陈倒酒说出'殿主'", to: "progressing", lastAdvancedChapter: chapter, advancedCount: 2 },
      { op: "resolve", hookId: H007, how: "对赌条款反噬江氏", echoFrom: "四道折痕" },
    ],
    stateChanges: { ["苏晴" as CharacterName]: { location: "江氏停车场", emotion: "震动" } },
  };
}

test("默认 fixture：viewForChapter(21) 渲染 §7.7 债务表（H007 mustResolve / H011 mustAdvance）", () => {
  const runtime = buildFakeBookRuntime();
  const ctx = runtime.ledger.viewForChapter(chapter);
  assert.ok(ctx.mustResolve.includes(H007));
  assert.ok(ctx.mustAdvance.includes(H011));
  assert.equal(ctx.budget.cap, 12);
  assert.equal(runtime.config.targetChapters, 100);
});

test("canReach：主线 active 可达；闪回线 dormant 未推进 → H014 不可达（§9.2 占位规则）", () => {
  const runtime = buildFakeBookRuntime();
  assert.equal(runtime.timeline.canReach(TL_MAIN, H007, chapter), true);
  assert.equal(runtime.timeline.canReach(TL_FLASHBACK_RAIN, H014, chapter), false);
});

test("knowledgeOf：信息差隔离（苏晴知道称呼，江辰不知道）", () => {
  const runtime = buildFakeBookRuntime();
  const su = runtime.truth.knowledgeOf("苏晴", chapter);
  const jiang = runtime.truth.knowledgeOf("江辰", chapter);
  assert.equal(su.length, 1);
  assert.equal(su[0]?.object, "殿主");
  assert.equal(jiang.length, 0);
});

test("settleChapter：applied 后账本/真相/时钟/角色状态同批更新", () => {
  const runtime = buildFakeBookRuntime();
  const before = runtime.ledgerView;
  const result = runtime.settleChapter(chapter, deltaFixture());
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  // 账本：H007 resolved、H011 progressing 且推进计数 +1
  assert.equal(runtime.ledgerView[H007]?.status, "resolved");
  assert.equal(runtime.ledgerView[H011]?.status, "progressing");
  assert.equal(runtime.ledgerView[H011]?.advancedCount, 2);
  // 不可变：原视图引用未被修改
  assert.equal(before[H007]?.status, "progressing");
  // 真相：新事实入库（factId 递增）
  const snapshot = runtime.truth.snapshot(chapter, []);
  assert.equal(snapshot.facts.length, 2);
  assert.equal(snapshot.facts[1]?.factId, "F002");
  assert.equal(snapshot.facts[1]?.sourceChapter, chapter);
  // 角色状态：stateChanges 合并
  assert.equal(runtime.characterStates["苏晴" as CharacterName]?.location, "江氏停车场");
  // 时钟：active 主线推进到本章
  const threads = runtime.timeline.snapshotFor(chapter);
  assert.equal(threads[TL_MAIN]?.syncPoint, chapter);
});

test("settleChapter：六步校验拒绝（unknown-hook）→ 任何状态不变（原子语义）", () => {
  const runtime = buildFakeBookRuntime();
  const before = runtime.ledgerView;
  const bad: RuntimeDelta = {
    facts: [],
    hookOps: [{ op: "resolve", hookId: "H999" as HookId, how: "x", echoFrom: "x" }],
    stateChanges: {},
  };
  const result = runtime.settleChapter(chapter, bad);
  assert.equal(result.kind, "rejected-batch");
  if (result.kind === "rejected-batch") assert.equal(result.rule, "unknown-hook");
  assert.deepEqual(runtime.ledgerView, before);
  assert.equal(runtime.truth.snapshot(chapter, []).facts.length, 1);
  assert.equal(runtime.characterStates["苏晴" as CharacterName]?.location, "江氏会议室");
});

test("settleChapter：重复 settle 幂等可恢复（H007 已 resolved → resolve 跳过非致命）", () => {
  const runtime = buildFakeBookRuntime();
  const r1 = runtime.settleChapter(chapter, deltaFixture());
  assert.equal(r1.kind, "applied");
  const r2 = runtime.settleChapter(chapter, deltaFixture());
  assert.equal(r2.kind, "applied");
  if (r2.kind !== "applied") return;
  assert.equal(runtime.ledgerView[H007]?.status, "resolved");
  assert.ok(r2.skipped.some((s) => s.reason.includes("resolved") || s.reason.includes("resolve")) || r2.skipped.length === 0);
});

test("insertAll：多条 delta 的 factId 顺序递增", () => {
  const runtime = buildFakeBookRuntime();
  const delta: RuntimeDelta = {
    facts: [
      { subject: "A", subjectType: "character", predicate: "p", object: "1", knownBy: [] },
      { subject: "B", subjectType: "character", predicate: "p", object: "2", knownBy: [] },
    ],
    hookOps: [],
    stateChanges: {},
  };
  const result = runtime.settleChapter(chapter, delta);
  assert.equal(result.kind, "applied");
  const facts = runtime.truth.snapshot(chapter, []).facts;
  assert.deepEqual(facts.slice(1).map((f) => f.factId), ["F002", "F003"]);
});

test("retcon：修正事实从本章起真，旧事实不再出现在快照（接口仅暴露 active 视图）", () => {
  const runtime = buildFakeBookRuntime();
  runtime.truth.retcon("F001", "大爷", chapter);
  const snapshot = runtime.truth.snapshot(chapter, []);
  // 旧事实（'殿主'）被修正后不再进入快照；新事实 F002 从本章起真
  assert.equal(snapshot.facts.find((f) => f.object === "殿主"), undefined);
  const replacement = snapshot.facts.find((f) => f.factId === "F002");
  assert.equal(replacement?.object, "大爷");
  assert.equal(replacement?.validFromChapter, chapter);
  assert.equal(replacement?.sourceChapter, chapter);
});

test("truth.validate：非空 + subjectType 枚举", () => {
  const runtime = buildFakeBookRuntime();
  const ok = runtime.truth.validate([{ factId: "F001" as FactId, subject: "a", subjectType: "character", predicate: "b", object: "c", validFromChapter: 1, validUntilChapter: null, sourceChapter: 1, status: "active" }], chapter);
  assert.equal(ok.valid, true);
  const bad = runtime.truth.validate([{ factId: "F001" as FactId, subject: "", subjectType: "unknown" as never, predicate: "b", object: "", validFromChapter: 1, validUntilChapter: null, sourceChapter: 1, status: "active" }], chapter);
  assert.equal(bad.valid, false);
  assert.equal(bad.violations.length, 3);
});
