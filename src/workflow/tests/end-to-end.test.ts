import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookId, CharacterName, Dispatch, EventId, HookId, ThreadId, WeavePlan } from "../../novel/types";
import type { BookRuntime } from "../../novel/runtime";
import { buildFakeBookRuntime } from "../../novel/runtime";
import { H007, H011 } from "../../novel/runtime/fixtures";
import { ChapterWorkflow } from "../engine";
import { StubAgent } from "../stub-agent";
import type { StubRule } from "../stub-agent";
import { buildChapterNodes } from "../nodes";
import type { WorkflowEvent, WorkflowStore, PersistedWorkflow } from "../types";

const bookId = "book-e2e-001" as BookId;
const chapter = 21;

/** §7.7 精简账本（H007 可回收 / H011 可推进）：viewForChapter(21) 的 must 集合与合规 Dispatch 精确匹配。 */
function e2eRuntime(): BookRuntime {
  return buildFakeBookRuntime({
    ledger: {
      [H007]: { hookId: H007, startChapter: 2, type: "物件", status: "progressing", lastAdvancedChapter: 19, advancedCount: 1, expectedPayoff: "对赌反噬", payoffTiming: "mid-arc", coreHook: true },
      [H011]: { hookId: H011, startChapter: 5, type: "信息差", status: "open", lastAdvancedChapter: 10, advancedCount: 1, expectedPayoff: "殿主称呼", payoffTiming: "slow-burn" },
    },
  });
}

/** 合规 Dispatch（§7.7 实例）：resolve H007、advance H007+H011（H007 age 大 → 公式同时标 mustResolve+mustAdvance）。 */
function compliantDispatch() {
  return {
    chapter,
    goal: "让江辰自己念出协议第三条，收束 H007",
    castPlan: [
      { name: "叶凡", tier: "S", role: "main", directive: "沉默。", hardLimits: [] },
      { name: "苏晴", tier: "S", role: "main", directive: "列席。", hardLimits: [] },
    ],
    threadPlan: [{ threadId: "tl-main-share", eventIds: ["E-M07"], slot: "middle" }],
    hookDirectives: {
      open: [],
      advance: [
        { hookId: H011, how: "老陈给出'殿主'称呼", to: "progressing" },
        { hookId: H007, how: "折痕第三次出现", to: "progressing" },
      ],
      resolve: [{ hookId: H007, how: "对赌条款反噬", echoFrom: "四道折痕" }],
      defer: [],
      mention: [],
    },
    styleNotes: ["对话占比 65%"],
    budget: { scenes: 3, chars: 2500 },
  };
}

/** 违规 Dispatch：resolve 为空 → must-resolve-not-covered。 */
function violatingDispatch() {
  const d = compliantDispatch();
  return { ...d, hookDirectives: { ...d.hookDirectives, resolve: [] } };
}

function simulationFixture() {
  return [
    { character: "叶凡", tier: "S", lines: ["念完了？"], actions: ["把笔放回笔筒"], suspects: ["苏晴开始怀疑协议与我有关"] },
    { character: "苏晴", tier: "S", lines: ["这纸……怎么折过四次？"], actions: [] },
  ];
}

function scenesheetFixture() {
  return {
    writingPlan: `本章按 ${chapter} 章调度：第 2 场收束 H007。`,
    scenes: [
      { no: 1, kind: "main", pov: "苏晴", slot: "start", purpose: "建立赌局", beats: ["法务逐条念协议"], cast: ["苏晴", "江辰"], material: { lines: ["这纸……怎么折过四次？"], actions: [], suspects: [] }, hookOps: [{ hookId: H007, op: "advance", how: "折痕第三次出现", echo: "四道折痕" }], budgetChars: 700, emotion: "压迫" },
    ],
    weavingNotes: "resolve 放第 2 场中段。",
    forbidden: ["不能提'龙王'"],
  };
}

function runtimeDeltaFixture() {
  return {
    facts: [{ subject: "老陈", subjectType: "character", predicate: "知道称呼", object: "殿主", knownBy: ["老陈", "苏晴"] }],
    hookOps: [
      { op: "advance", hookId: H011, how: "老陈倒酒说出'殿主'", to: "progressing", lastAdvancedChapter: 21, advancedCount: 2 },
      { op: "resolve", hookId: H007, how: "对赌条款反噬江氏", echoFrom: "四道折痕" },
    ],
    stateChanges: { 苏晴: { location: "江氏停车场", emotion: "震动" } },
  };
}

/** 全任务合规规则表。 */
function fullRules(): StubRule[] {
  return [
    { task: "direct", responses: [{ json: compliantDispatch() }] },
    { task: "simulate", responses: [{ json: simulationFixture() }] },
    { task: "merge", responses: [{ json: scenesheetFixture() }] },
    { task: "write", responses: [{ text: "第 21 章正文……" }] },
    { task: "audit", responses: [{ text: "PASS 伏笔/事实/角色一致性无偏差" }] },
    { task: "censor", responses: [{ text: "PASS 无红线问题" }] },
    { task: "settle", responses: [{ json: runtimeDeltaFixture() }] },
  ];
}

class MemoryStore implements WorkflowStore {
  private readonly records = new Map<string, PersistedWorkflow>();
  private key(bookId: BookId, chapter: number): string { return `${bookId}:${chapter}`; }
  async load(bookId: BookId, chapter: number): Promise<PersistedWorkflow | undefined> {
    const record = this.records.get(this.key(bookId, chapter));
    return record === undefined ? undefined : { ...record, state: { ...record.state }, artifacts: { ...record.artifacts } };
  }
  async save(record: PersistedWorkflow): Promise<void> {
    this.records.set(this.key(record.bookId, record.chapter), { ...record, state: { ...record.state }, artifacts: { ...record.artifacts } });
  }
  get latest(): PersistedWorkflow | undefined { return [...this.records.values()].at(-1); }
}

function runAll(agent: StubAgent, store: WorkflowStore, runtime: BookRuntime, notify?: (e: WorkflowEvent) => void) {
  return new ChapterWorkflow({ nodes: buildChapterNodes(agent, { runtime }), store, maxRetries: 2, notify }).run(bookId, chapter);
}

test("端到端：7 步全流程经 StubAgent 跑通，产物七项齐全且类型正确", async () => {
  const store = new MemoryStore();
  const runtime = e2eRuntime();
  const agent = new StubAgent(fullRules());
  const result = await runAll(agent, store, runtime);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  const latest = store.latest;
  assert.ok(latest);
  const a = latest.artifacts;
  const dispatch = a.direct as Dispatch;
  assert.equal(dispatch.chapter, chapter);
  assert.equal(dispatch.hookDirectives.resolve[0]?.hookId, H007);
  assert.equal((a.simulate as unknown[]).length, 2);
  const merge = a.merge as { weavePlan: WeavePlan; scenesheet: { writingPlan: string } };
  assert.equal(merge.weavePlan.mainEvents[0], "E-M07");
  assert.equal(merge.scenesheet.writingPlan, `本章按 ${chapter} 章调度：第 2 场收束 H007。`);
  assert.equal(a.write, "第 21 章正文……");
  assert.match(a.audit as string, /^PASS/);
  assert.match(a.censor as string, /^PASS/);
  const delta = a.settle as { hookOps: readonly { op: string }[] };
  assert.equal(delta.hookOps[0]?.op, "advance");
  // 七步各落盘一次
  const record = store.latest;
  assert.ok(record);
  assert.equal(Object.keys(record.artifacts).length, 7);
  // 每步调用一次 agent
  assert.equal(agent.count(), 7);
  // settle 已回写 BookRuntime：H007 resolved、H011 progressing
  assert.equal(runtime.ledgerView[H007]?.status, "resolved");
  assert.equal(runtime.ledgerView[H011]?.status, "progressing");
});

test("端到端：闸门拒绝 → retry 回 direct，第二次合规后跑通", async () => {
  const store = new MemoryStore();
  const runtime = e2eRuntime();
  const rules: StubRule[] = [
    { task: "direct", responses: [{ json: violatingDispatch() }, { json: compliantDispatch() }] },
    ...fullRules().slice(1),
  ];
  const agent = new StubAgent(rules);
  const events: WorkflowEvent[] = [];
  const result = await runAll(agent, store, runtime, (e) => events.push(e));
  assert.equal(result.kind, "completed");
  assert.equal(agent.count("direct"), 2);
  assert.deepEqual(events.filter((e) => e.type === "retrying").map((e) => e.type), ["retrying"]);
  const dispatch = store.latest?.artifacts.direct as Dispatch;
  assert.equal(dispatch.hookDirectives.resolve.length, 1);
});

test("端到端：审计不过 → 回 write 重写 → 二次通过后跑通", async () => {
  const store = new MemoryStore();
  const rules: StubRule[] = [
    { task: "direct", responses: [{ json: compliantDispatch() }] },
    { task: "simulate", responses: [{ json: simulationFixture() }] },
    { task: "merge", responses: [{ json: scenesheetFixture() }] },
    { task: "write", responses: [{ text: "第一稿（漏收 H007）" }, { text: "第二稿（补上回收）" }] },
    { task: "audit", responses: [{ text: "FAIL 漏收 H007" }, { text: "PASS 无偏差" }] },
    { task: "censor", responses: [{ text: "PASS 无红线问题" }] },
    { task: "settle", responses: [{ json: runtimeDeltaFixture() }] },
  ];
  const agent = new StubAgent(rules);
  const runtime = e2eRuntime();
  const events: WorkflowEvent[] = [];
  const result = await runAll(agent, store, runtime, (e) => events.push(e));
  assert.equal(result.kind, "completed");
  assert.equal(agent.count("write"), 2);
  assert.equal(agent.count("audit"), 2);
  assert.deepEqual(events.filter((e) => e.type === "retrying").map((e) => e.type), ["retrying"]);
  assert.equal(store.latest?.artifacts.write, "第二稿（补上回收）");
});

test("端到端：settle agent 失败 → failed；修复后断点续跑 → completed 且不重跑前序", async () => {
  const store = new MemoryStore();
  const runtime = e2eRuntime();
  // 第一轮：settle 无匹配规则 → agent 抛错 → 节点转 fail
  const agent1 = new StubAgent(fullRules().filter((r) => r.task !== "settle"));
  const r1 = await runAll(agent1, store, runtime);
  assert.equal(r1.kind, "failed");
  if (r1.kind !== "failed") return;
  assert.match(r1.reason, /settle agent 调用失败/);
  // 修复后换新 agent（同一 store）：从 settle 断点续跑
  const agent2 = new StubAgent(fullRules());
  const r2 = await runAll(agent2, store, runtime);
  assert.equal(r2.kind, "completed");
  assert.equal(agent2.count("settle"), 1);
  assert.equal(agent2.count("direct"), 0); // 未重跑前序
  const latest = store.latest;
  assert.ok(latest);
  assert.equal(latest.state.status, "settled");
});
