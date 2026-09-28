import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_ORDER } from "../../novel/types";
import type { BookId, CharacterName, Dispatch, EventId, HookId, RuntimeDelta, Simulation, ThreadId } from "../../novel/types";
import { ChapterWorkflow } from "../engine";
import { artifactOf } from "../types";
import type { MergeArtifacts, NodeOutputOf, PersistedWorkflow, StepNode, WorkflowStore } from "../types";

/* 编译期断言：产物表把步骤映射到精确的运行时结构。 */
type Expect<T extends true> = T;
type _directOut = Expect<NodeOutputOf<"direct"> extends Dispatch ? true : false>;
type _simulateOut = Expect<NodeOutputOf<"simulate"> extends readonly Simulation[] ? true : false>;
type _mergeOut = Expect<NodeOutputOf<"merge"> extends MergeArtifacts ? true : false>;
type _settleOut = Expect<NodeOutputOf<"settle"> extends RuntimeDelta ? true : false>;

const bookId = "book-contract-001" as BookId;
const chapter = 21;

/** 类型化 direct 节点：StepNode<'direct'> 的 output 即 Dispatch。 */
const directNode: StepNode<"direct"> = {
  step: "direct",
  run: async () => ({
    outcome: { kind: "continue" },
    output: {
      chapter,
      goal: "让江辰自己念出协议第三条，收束 H007",
      castPlan: [
        { name: "叶凡" as CharacterName, tier: "S", role: "main", directive: "沉默。等江辰念完第三条再开口。", hardLimits: ["不能对苏晴坦白"] },
        { name: "苏晴" as CharacterName, tier: "S", role: "main", directive: "列席董事局。", hardLimits: [] },
      ],
      threadPlan: [{ threadId: "tl-main-share" as ThreadId, eventIds: ["E-M07" as EventId], slot: "middle" }],
      hookDirectives: {
        open: [],
        advance: [{ hookId: "H011" as HookId, how: "老陈给出'殿主'称呼的新信息", to: "progressing" }],
        resolve: [{ hookId: "H007" as HookId, how: "回收对赌条款", echoFrom: "四道折痕" }],
        defer: [],
        mention: [],
      },
      styleNotes: ["对话占比 65%"],
      budget: { scenes: 3, chars: 2500 },
    },
  }),
};

/** 类型化 simulate 节点：output 为 Simulation[]。 */
const simulateNode: StepNode<"simulate"> = {
  step: "simulate",
  run: async () => ({
    outcome: { kind: "continue" },
    output: [
      {
        character: "叶凡" as CharacterName, tier: "S",
        lines: ["念完了？"], actions: ["把笔放回笔筒，转了半圈"],
        suspects: ["苏晴开始怀疑协议与我有关"], reasoning: "她要看我慌，我偏不慌。", risk: "苏晴会以为我放弃了。",
      },
      {
        character: "苏晴" as CharacterName, tier: "S",
        lines: ["这纸……怎么折过四次？"], actions: [], suspects: ["叶凡早就看过这份协议"],
      },
    ],
  }),
};

/** 类型化 merge 节点：经 artifactOf 安全取前序产物（Dispatch / Simulation[]），output 为 { weavePlan, scenesheet }。 */
const mergeNode: StepNode<"merge"> = {
  step: "merge",
  run: async (ctx) => {
    const dispatch = artifactOf(ctx, "direct");
    const sims = artifactOf(ctx, "simulate");
    assert.ok(dispatch, "direct 产物应已就绪");
    assert.ok(sims, "simulate 产物应已就绪");
    return {
      outcome: { kind: "continue" },
      output: {
        weavePlan: {
          mainEvents: ["E-M07" as EventId],
          sideInserts: [{ threadId: "tl-side-wine" as ThreadId, eventIds: ["E-S03" as EventId], slot: "end", castOverlap: ["老陈" as CharacterName] }],
          blocked: [],
        },
        scenesheet: {
          writingPlan: `本章按 ${dispatch.chapter} 章调度：第 2 场收束 H007，第 3 场推进 H011。`,
          scenes: [
            {
              no: 1, kind: "main", pov: "苏晴" as CharacterName, slot: "start",
              purpose: "建立赌局",
              beats: ["法务逐条念协议"],
              cast: ["苏晴" as CharacterName, "江辰" as CharacterName],
              material: { lines: sims[1]?.lines ?? [], actions: [], suspects: sims[1]?.suspects ?? [] },
              hookOps: [{ hookId: "H007" as HookId, op: "advance", how: "折痕第三次出现", echo: "四道折痕" }],
              budgetChars: 700, emotion: "压迫",
            },
          ],
          weavingNotes: "resolve 放第 2 场中段，结尾让给 H011 的 advance。",
          forbidden: ["不能提'龙王'"],
        },
      },
    };
  },
};

/** 纯文本产物节点（write/audit/censor）。 */
function textNode(step: "write" | "audit" | "censor", text: string): StepNode<typeof step> {
  return { step, run: async () => ({ outcome: { kind: "continue" }, output: text }) };
}

/** 类型化 settle 节点：output 为 RuntimeDelta。 */
const settleNode: StepNode<"settle"> = {
  step: "settle",
  run: async (ctx) => {
    const draft = artifactOf(ctx, "write");
    assert.ok(draft);
    return {
      outcome: { kind: "continue" },
      output: {
        facts: [
          { subject: "老陈", subjectType: "character", predicate: "知道称呼", object: "殿主", knownBy: ["老陈" as CharacterName, "苏晴" as CharacterName] },
        ],
        hookOps: [
          { op: "advance", hookId: "H011" as HookId, how: "老陈倒酒说出'殿主'", to: "progressing", lastAdvancedChapter: 21, advancedCount: 2 },
          { op: "resolve", hookId: "H007" as HookId, how: "对赌条款反噬江氏", echoFrom: "四道折痕" },
        ],
        stateChanges: { ["苏晴" as CharacterName]: { location: "江氏停车场", emotion: "震动", suspects: ["'殿主'不是公司职称"] } },
      },
    };
  },
};

/** 内存存储替身。 */
class MemoryStore implements WorkflowStore {
  private readonly records = new Map<string, PersistedWorkflow>();
  private key(bookId: BookId, chapter: number): string { return `${bookId}:${chapter}`; }
  saves = 0;
  async load(bookId: BookId, chapter: number): Promise<PersistedWorkflow | undefined> {
    const record = this.records.get(this.key(bookId, chapter));
    return record === undefined ? undefined : { ...record, state: { ...record.state }, artifacts: { ...record.artifacts } };
  }
  async save(record: PersistedWorkflow): Promise<void> {
    this.saves++;
    this.records.set(this.key(record.bookId, record.chapter), { ...record, state: { ...record.state }, artifacts: { ...record.artifacts } });
  }
  get latest(): PersistedWorkflow | undefined { return [...this.records.values()].at(-1); }
}

test("类型化节点全流程：direct 产物为 Dispatch、merge 经 artifactOf 取前序、settle 产物为 RuntimeDelta", async () => {
  const store = new MemoryStore();
  const workflow = new ChapterWorkflow({
    nodes: [
      directNode,
      simulateNode,
      mergeNode,
      textNode("write", "第 21 章正文……"),
      textNode("audit", "audit-pass"),
      textNode("censor", "censor-pass"),
      settleNode,
    ],
    store, maxRetries: 2,
  });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  const latest = store.latest;
  assert.ok(latest);
  // 持久化层按字符串索引，取用时按产物表（ChapterStepArtifacts）断言精确类型
  const dispatch = latest.artifacts.direct as Dispatch;
  assert.equal(dispatch.chapter, 21);
  assert.equal(dispatch.hookDirectives.resolve[0]?.hookId, "H007");
  const sims = latest.artifacts.simulate as readonly Simulation[];
  assert.equal(sims.length, 2);
  const merge = latest.artifacts.merge as MergeArtifacts;
  assert.equal(merge.weavePlan.mainEvents.length, 1);
  assert.equal(merge.scenesheet.scenes[0]?.hookOps[0]?.echo, "四道折痕");
  const delta = latest.artifacts.settle as RuntimeDelta;
  assert.equal(delta.hookOps[0]?.op, "advance");
  assert.equal(store.saves, STEP_ORDER.length);
});

test("artifactOf：未产出的步骤返回 undefined，类型为对应产物", () => {
  const store = new MemoryStore();
  const ctx = { bookId, chapter, state: { bookId, chapter, step: "direct" as const, status: "planned" as const, retries: 0 }, artifacts: {} };
  assert.equal(artifactOf(ctx, "direct"), undefined);
  assert.equal(artifactOf(ctx, "settle"), undefined);
  void store;
});
