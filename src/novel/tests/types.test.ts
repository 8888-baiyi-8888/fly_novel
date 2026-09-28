import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_ORDER, canTransitionHookStatus } from "../types";
import type {
  ChapterStatus, EventStatus, FactStatus, HookStatus, HookTiming, HookType,
  Pacing, Step, SubjectKind, ThreadKind, ThreadStatus, Tier,
} from "../types";

test("STEP_ORDER 是七个步骤的固定顺序且无重复", () => {
  assert.deepEqual(STEP_ORDER, ["direct", "simulate", "merge", "write", "audit", "censor", "settle"]);
  assert.equal(new Set(STEP_ORDER).size, STEP_ORDER.length);
});

test("伏笔状态迁移：主链单调前进，deferred 可恢复，resolved 为终态", () => {
  const allowed: ReadonlyArray<readonly [HookStatus, HookStatus]> = [
    ["open", "progressing"], ["open", "resolved"], ["open", "deferred"],
    ["progressing", "resolved"], ["progressing", "deferred"],
    ["deferred", "open"], ["deferred", "progressing"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransitionHookStatus(from, to), true, `${from} -> ${to} 应当允许`);
  }
  const forbidden: ReadonlyArray<readonly [HookStatus, HookStatus]> = [
    ["open", "open"],
    ["progressing", "open"], ["progressing", "progressing"],
    ["deferred", "resolved"], ["deferred", "deferred"],
    ["resolved", "open"], ["resolved", "progressing"], ["resolved", "deferred"], ["resolved", "resolved"],
  ];
  for (const [from, to] of forbidden) {
    assert.equal(canTransitionHookStatus(from, to), false, `${from} -> ${to} 应当禁止`);
  }
});

/* 编译期断言：各枚举的字面量集合完整（运行时不产生任何执行）。
   Genre / Platform 已于 2026-09-28 对接小说流时放宽为 string（上游用原文），不再穷尽。 */
type Expect<T extends true> = T;
type _step = Expect<[Exclude<Step, "direct" | "simulate" | "merge" | "write" | "audit" | "censor" | "settle">] extends [never] ? true : false>;
type _chapterStatus = Expect<[Exclude<ChapterStatus, "planned" | "simulated" | "woven" | "drafted" | "audited" | "censored" | "settled" | "approved">] extends [never] ? true : false>;
type _hookStatus = Expect<[Exclude<HookStatus, "open" | "progressing" | "deferred" | "resolved">] extends [never] ? true : false>;
type _hookTiming = Expect<[Exclude<HookTiming, "immediate" | "near-term" | "mid-arc" | "slow-burn" | "endgame">] extends [never] ? true : false>;
type _hookType = Expect<[Exclude<HookType, "物件" | "身份" | "信息差" | "承诺" | "威胁" | "秘密" | "关系" | "能力" | "事件">] extends [never] ? true : false>;
type _threadKind = Expect<[Exclude<ThreadKind, "main" | "side" | "flashback" | "interlude">] extends [never] ? true : false>;
type _threadStatus = Expect<[Exclude<ThreadStatus, "active" | "dormant" | "completed" | "abandoned">] extends [never] ? true : false>;
type _eventStatus = Expect<[Exclude<EventStatus, "pending" | "written" | "settled">] extends [never] ? true : false>;
type _subjectKind = Expect<[Exclude<SubjectKind, "character" | "location" | "item" | "relationship" | "event" | "world">] extends [never] ? true : false>;
type _factStatus = Expect<[Exclude<FactStatus, "active" | "retconned" | "suspended">] extends [never] ? true : false>;
type _pacing = Expect<[Exclude<Pacing, "铺垫" | "上升" | "紧张" | "释放" | "舒缓">] extends [never] ? true : false>;
type _tier = Expect<[Exclude<Tier, "S" | "A" | "B">] extends [never] ? true : false>;
