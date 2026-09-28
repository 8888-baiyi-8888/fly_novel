import assert from "node:assert/strict";
import { test } from "node:test";
import type { CharacterName, Dispatch, EventId, HookId, ThreadId } from "../types";
import { validateDispatch } from "../gates/dispatch-gate";
import type { DispatchGateLedgerEntry, DispatchGateRule } from "../gates/dispatch-gate";

const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const H019 = "H019" as HookId;
const H023 = "H023" as HookId;
const H999 = "H999" as HookId;
const chapter = 21;

/** 合规账本：H007（已埋设、已推进、可回收）、H011（已埋设、可推进）、H023（非 core 可挂起）。 */
function makeLedger(): Readonly<Record<HookId, DispatchGateLedgerEntry>> {
  return {
    [H007]: { status: "progressing", startChapter: 2, lastAdvancedChapter: 19, coreHook: true },
    [H011]: { status: "open", startChapter: 5, lastAdvancedChapter: 10, coreHook: false },
    [H023]: { status: "open", startChapter: 12, lastAdvancedChapter: 18, coreHook: false },
  };
}

/** 合规债务表：mustResolve=H007、mustAdvance=H011，允许开新。 */
type Ctx = Parameters<typeof validateDispatch>[0]["context"];
function makeContext(overrides: Partial<Ctx> = {}): Ctx {
  return {
    mustResolve: [H007],
    mustAdvance: [H011],
    canResolve: [],
    canAdvance: [H019],
    mustNotDefer: [H007],
    pressure: {},
    staleDebt: [],
    budget: { activeCount: 3, cap: 12, openAllowed: true },
    ...overrides,
  };
}

/** 合规 Dispatch：resolve H007、advance H011，open 数(0) ≤ resolve 数(1)。 */
function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    chapter,
    goal: "让江辰自己念出协议第三条，收束 H007",
    castPlan: [
      { name: "叶凡" as CharacterName, tier: "S", role: "main", directive: "沉默。", hardLimits: [] },
      { name: "苏晴" as CharacterName, tier: "S", role: "main", directive: "列席。", hardLimits: [] },
    ],
    threadPlan: [{ threadId: "tl-main-share" as ThreadId, eventIds: ["E-M07" as EventId], slot: "middle" }],
    hookDirectives: {
      open: [],
      advance: [{ hookId: H011, how: "老陈给出'殿主'称呼", to: "progressing" }],
      resolve: [{ hookId: H007, how: "对赌条款反噬", echoFrom: "四道折痕" }],
      defer: [],
      mention: [],
    },
    styleNotes: [],
    budget: { scenes: 3, chars: 2500 },
    ...overrides,
  };
}

function run(dispatch: Dispatch, context = makeContext(), ledger = makeLedger()) {
  return validateDispatch({ dispatch, context, ledger });
}

test("通过：合规 Dispatch（mustResolve/mustAdvance 全覆盖、无违规）", () => {
  const verdict = run(makeDispatch());
  assert.equal(verdict.passed, true);
});

test("规则 1：mustResolve 未进入 resolve 列表 → must-resolve-not-covered", () => {
  const dispatch = makeDispatch({ hookDirectives: { ...makeDispatch().hookDirectives, resolve: [] } });
  const verdict = run(dispatch);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    assert.equal(verdict.violations.length, 1);
    assert.deepEqual(verdict.violations[0]?.rule, "must-resolve-not-covered");
    assert.deepEqual(verdict.violations[0]?.hookIds, [H007]);
  }
});

test("规则 2：mustAdvance 未进入 advance 列表 → must-advance-not-covered", () => {
  const dispatch = makeDispatch({ hookDirectives: { ...makeDispatch().hookDirectives, advance: [] } });
  const verdict = run(dispatch);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) assert.deepEqual(verdict.violations[0]?.rule, "must-advance-not-covered");
});

test("规则 3：resolve/advance 引用账本中不存在的 hookId → unknown-hook", () => {
  const dispatch = makeDispatch({
    hookDirectives: {
      open: [], advance: [], resolve: [{ hookId: H999, how: "编造", echoFrom: "x" }], defer: [], mention: [],
    },
  });
  const verdict = run(dispatch, makeContext({ mustResolve: [], mustAdvance: [] }));
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    assert.equal(verdict.violations.length, 1);
    assert.deepEqual(verdict.violations[0]?.rule, "unknown-hook");
    assert.deepEqual(verdict.violations[0]?.hookIds, [H999]);
  }
});

test("规则 4：resolve 尚未埋设的伏笔（open 且 lastAdvanced=0 且 startChapter>本章）→ resolve-unplanted", () => {
  const ledger: Readonly<Record<HookId, DispatchGateLedgerEntry>> = {
    ...makeLedger(),
    [H019]: { status: "open", startChapter: 30, lastAdvancedChapter: 0, coreHook: false },
  };
  const dispatch = makeDispatch({
    hookDirectives: {
      open: [], advance: [], resolve: [{ hookId: H019, how: "提前引爆", echoFrom: "x" }], defer: [], mention: [],
    },
  });
  const verdict = run(dispatch, makeContext({ mustResolve: [], mustAdvance: [] }), ledger);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    assert.equal(verdict.violations.length, 1);
    assert.deepEqual(verdict.violations[0]?.rule, "resolve-unplanted");
  }
});

test("规则 4 边界：已埋设（startChapter ≤ 本章）或非 open 不触发", () => {
  // 已埋设且推进过（progressing）：允许 resolve
  const ok = run(makeDispatch());
  assert.equal(ok.passed, true);
  // open 但 startChapter=2（已埋设）且 lastAdvanced=0：允许 resolve（埋设完成）
  const ledger: Readonly<Record<HookId, DispatchGateLedgerEntry>> = {
    [H007]: { status: "open", startChapter: 2, lastAdvancedChapter: 0, coreHook: true },
  };
  const dispatch = makeDispatch({
    hookDirectives: {
      open: [], advance: [], resolve: [{ hookId: H007, how: "回收", echoFrom: "x" }], defer: [], mention: [],
    },
  });
  const verdict = run(dispatch, makeContext({ mustResolve: [H007], mustAdvance: [] }), ledger);
  assert.equal(verdict.passed, true);
});

test("规则 5：open 数多于 resolve 数 → open-without-payback；开一还一不触发", () => {
  const bad = makeDispatch({
    hookDirectives: {
      open: [{ type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "x" }],
      advance: [], resolve: [], defer: [], mention: [],
    },
  });
  const badVerdict = run(bad, makeContext({ mustResolve: [], mustAdvance: [] }));
  assert.equal(badVerdict.passed, false);
  if (!badVerdict.passed) {
    assert.equal(badVerdict.violations.length, 1);
    assert.deepEqual(badVerdict.violations[0]?.rule, "open-without-payback");
  }
  // 开一还一：不触发（文档严格 < 会误拒此处，实现按 ≤）
  const fine = makeDispatch({
    hookDirectives: {
      open: [{ type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "x" }],
      advance: [], resolve: [{ hookId: H007, how: "回收", echoFrom: "x" }], defer: [], mention: [],
    },
  });
  assert.equal(run(fine, makeContext({ mustResolve: [H007], mustAdvance: [] })).passed, true);
});

test("规则 6：budget.openAllowed=false 时仍含 open → open-when-disallowed", () => {
  const context = makeContext({ mustResolve: [], mustAdvance: [], budget: { activeCount: 12, cap: 12, openAllowed: false } });
  const dispatch = makeDispatch({
    hookDirectives: {
      open: [{ type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "x" }],
      advance: [], resolve: [{ hookId: H007, how: "回收", echoFrom: "x" }], defer: [], mention: [],
    },
  });
  const verdict = run(dispatch, context);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    assert.equal(verdict.violations.length, 1);
    assert.deepEqual(verdict.violations[0]?.rule, "open-when-disallowed");
  }
});

test("规则 7：defer 命中 coreHook → defer-core-hook", () => {
  const dispatch = makeDispatch({
    hookDirectives: { ...makeDispatch().hookDirectives, defer: [{ hookId: H007, reason: "拖一拖", untilChapter: 30 }] },
  });
  const verdict = run(dispatch);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    assert.deepEqual(verdict.violations[0]?.rule, "defer-core-hook");
    assert.deepEqual(verdict.violations[0]?.hookIds, [H007]);
  }
  // 非 core 可 defer
  const fine = makeDispatch({
    hookDirectives: { ...makeDispatch().hookDirectives, defer: [{ hookId: H023, reason: "需先完成 H019", untilChapter: 34 }] },
  });
  assert.equal(run(fine).passed, true);
});

test("多违规聚合：同时违反规则 1/5/6 时 violations 完整列出", () => {
  const context = makeContext({ budget: { activeCount: 12, cap: 12, openAllowed: false } });
  const dispatch = makeDispatch({
    hookDirectives: {
      open: [{ type: "秘密", description: "新伏笔", payoffTiming: "near-term", expectedPayoff: "x", echoHint: "x" }],
      advance: [],
      resolve: [],
      defer: [],
      mention: [],
    },
  });
  const verdict = run(dispatch, context);
  assert.equal(verdict.passed, false);
  if (!verdict.passed) {
    const rules = verdict.violations.map((v) => v.rule) as DispatchGateRule[];
    assert.deepEqual(rules.sort(), ["must-advance-not-covered", "must-resolve-not-covered", "open-when-disallowed", "open-without-payback"].sort());
  }
});
