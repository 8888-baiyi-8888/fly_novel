import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_ORDER } from "../../novel/types";
import type { BookId, Step } from "../../novel/types";
import { ChapterWorkflow, createInitialChapterState, statusAfterStep } from "../engine";
import type { NodeOutput, NodeOutputOf, PersistedWorkflow, StepNode, StepOutcome, WorkflowEvent, WorkflowStore } from "../types";

const bookId = "book-stub-001" as BookId;
const chapter = 1;
const allSteps: readonly Step[] = STEP_ORDER;

/** 固定产物的桩节点。 */
function stubNode(step: Step, output?: NodeOutputOf<Step>, outcome: StepOutcome = { kind: "continue" }): StepNode {
  return { step, run: async () => ({ outcome, output: output ?? `${step}-out` }) };
}

/** 记录调用顺序的桩节点。 */
function trackingNode(step: Step, calls: Step[], output?: NodeOutputOf<Step>): StepNode {
  return { step, run: async () => { calls.push(step); return { outcome: { kind: "continue" }, output: output ?? `${step}-out` }; } };
}

/** 内存存储替身：记录落盘次数，latest 返回最近一次记录。 */
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

test("正常路径：七步顺序执行、逐步入盘、状态推进到 settled", async () => {
  const calls: Step[] = [];
  const store = new MemoryStore();
  const events: WorkflowEvent[] = [];
  const workflow = new ChapterWorkflow({
    nodes: allSteps.map((step) => trackingNode(step, calls)),
    store, maxRetries: 2, notify: (event) => events.push(event),
  });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(calls, STEP_ORDER);
  assert.equal(result.state.step, "settle");
  assert.equal(result.state.status, "settled");
  assert.equal(result.state.retries, 0);
  assert.equal(store.saves, STEP_ORDER.length);
  const latest = store.latest;
  assert.ok(latest);
  for (const step of STEP_ORDER) assert.equal(latest.artifacts[step], `${step}-out`);
  assert.equal(events.filter((event) => event.type === "step-completed").length, 7);
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
});

test("审计重试环：audit 前两次不过 → 回 write 重写，第三次通过 → settled，产物覆盖/保留正确", async () => {
  const calls: Step[] = [];
  const store = new MemoryStore();
  const events: WorkflowEvent[] = [];
  let auditFailures = 2;
  let writeAttempts = 0;
  const nodes = allSteps.map((step): StepNode => {
    if (step === "audit") {
      return {
        step,
        run: async () => {
          calls.push(step);
          if (auditFailures > 0) {
            auditFailures--;
            return { outcome: { kind: "retry", step: "write", reason: "伏笔无推进" } };
          }
          return { outcome: { kind: "continue" }, output: "audit-pass" };
        },
      };
    }
    if (step === "write") {
      return {
        step,
        run: async () => {
          calls.push(step);
          writeAttempts++;
          return { outcome: { kind: "continue" }, output: `draft-${writeAttempts}` };
        },
      };
    }
    return trackingNode(step, calls);
  });
  const workflow = new ChapterWorkflow({ nodes, store, maxRetries: 2, notify: (event) => events.push(event) });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  // write 首轮 + 2 次重试 = 3 次；audit 失败 2 次 + 通过 1 次 = 3 次
  assert.equal(calls.filter((step) => step === "write").length, 3);
  assert.equal(calls.filter((step) => step === "audit").length, 3);
  // 重试只重跑 write 及其后步骤，simulate/merge 不重跑
  assert.equal(calls.filter((step) => step === "simulate").length, 1);
  assert.equal(calls.filter((step) => step === "merge").length, 1);
  assert.equal(result.state.retries, 2);
  assert.equal(result.state.status, "settled");
  const latest = store.latest;
  assert.ok(latest);
  assert.equal(latest.artifacts.write, "draft-3");
  assert.equal(latest.artifacts.simulate, "simulate-out");
  const retries = events.filter((event): event is Extract<WorkflowEvent, { type: "retrying" }> => event.type === "retrying");
  assert.equal(retries.length, 2);
  assert.deepEqual(retries.map((event) => event.to), ["write", "write"]);
  assert.deepEqual(retries.map((event) => event.attempt), [1, 2]);
});

test("预算耗尽：audit 一直不过 → 两次重写后挂起并通知，现场保留在回退目标", async () => {
  const store = new MemoryStore();
  const events: WorkflowEvent[] = [];
  const nodes = allSteps.map((step): StepNode => step === "audit"
    ? { step, run: async () => ({ outcome: { kind: "retry", step: "write", reason: "始终不过" } }) }
    : stubNode(step));
  const workflow = new ChapterWorkflow({ nodes, store, maxRetries: 2, notify: (event) => events.push(event) });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "suspended");
  if (result.kind !== "suspended") return;
  assert.equal(result.reason, "始终不过");
  assert.equal(result.state.retries, 2);
  assert.equal(result.state.step, "write");
  assert.equal(events.filter((event) => event.type === "suspended").length, 1);
});

test("断点续跑：从 merge 继续，不重跑 direct/simulate，前序产物保留", async () => {
  const store = new MemoryStore();
  await store.save({
    bookId, chapter,
    state: { bookId, chapter, step: "merge", status: "woven", retries: 0 },
    artifacts: { direct: "direct-out", simulate: "simulate-out" },
  });
  const calls: Step[] = [];
  const workflow = new ChapterWorkflow({ nodes: allSteps.map((step) => trackingNode(step, calls)), store, maxRetries: 2 });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(calls, ["merge", "write", "audit", "censor", "settle"]);
  const latest = store.latest;
  assert.ok(latest);
  assert.equal(latest.artifacts.direct, "direct-out");
});

test("已完结章节直接返回 already-complete，不执行任何节点", async () => {
  const store = new MemoryStore();
  await store.save({
    bookId, chapter,
    state: { bookId, chapter, step: "settle", status: "settled", retries: 0 },
    artifacts: {},
  });
  let ran = false;
  const workflow = new ChapterWorkflow({
    nodes: allSteps.map((step) => ({ step, run: async () => { ran = true; return { outcome: { kind: "continue" } }; } })),
    store, maxRetries: 2,
  });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "already-complete");
  assert.equal(ran, false);
});

test("缺节点：run 返回 invalid 并指明缺失步骤", async () => {
  const store = new MemoryStore();
  const workflow = new ChapterWorkflow({
    nodes: allSteps.filter((step) => step !== "direct").map((step) => stubNode(step)),
    store, maxRetries: 2,
  });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /direct/);
});

test("构造校验：非法步骤与重复节点在构造期报错", () => {
  const store = new MemoryStore();
  assert.throws(
    () => new ChapterWorkflow({ nodes: [{ step: "bogus" as Step, run: async () => ({ outcome: { kind: "continue" } }) }], store, maxRetries: 2 }),
    /非法步骤/,
  );
  assert.throws(
    () => new ChapterWorkflow({ nodes: [stubNode("direct"), stubNode("direct")], store, maxRetries: 2 }),
    /重复步骤/,
  );
});

test("节点 fail：直接失败并通知，现场落盘", async () => {
  const store = new MemoryStore();
  const events: WorkflowEvent[] = [];
  const nodes = allSteps.map((step): StepNode => step === "write"
    ? { step, run: async () => ({ outcome: { kind: "fail", reason: "模型不可用" } }) }
    : stubNode(step));
  const workflow = new ChapterWorkflow({ nodes, store, maxRetries: 2, notify: (event) => events.push(event) });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.reason, "模型不可用");
  assert.equal(result.state.step, "write");
  assert.equal(events.filter((event) => event.type === "failed").length, 1);
});

test("节点 suspend：直接挂起，现场停在当前步骤", async () => {
  const store = new MemoryStore();
  const nodes = allSteps.map((step): StepNode => step === "censor"
    ? { step, run: async () => ({ outcome: { kind: "suspend", reason: "需要人工复核" } }) }
    : stubNode(step));
  const workflow = new ChapterWorkflow({ nodes, store, maxRetries: 2 });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "suspended");
  if (result.kind !== "suspended") return;
  assert.equal(result.reason, "需要人工复核");
  assert.equal(result.state.step, "censor");
});

test("非法回退目标：run 返回 invalid", async () => {
  const store = new MemoryStore();
  const nodes = allSteps.map((step): StepNode => step === "audit"
    ? { step, run: async () => ({ outcome: { kind: "retry", step: "bogus" as Step, reason: "x" } }) }
    : stubNode(step));
  const workflow = new ChapterWorkflow({ nodes, store, maxRetries: 2 });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /非法回退目标/);
});

test("状态推进映射与初始状态", () => {
  assert.equal(statusAfterStep("direct"), "planned");
  assert.equal(statusAfterStep("simulate"), "simulated");
  assert.equal(statusAfterStep("merge"), "woven");
  assert.equal(statusAfterStep("write"), "drafted");
  assert.equal(statusAfterStep("audit"), "audited");
  assert.equal(statusAfterStep("censor"), "censored");
  assert.equal(statusAfterStep("settle"), "settled");
  assert.deepEqual(createInitialChapterState(bookId, chapter), { bookId, chapter, step: "direct", status: "planned", retries: 0 });
});
