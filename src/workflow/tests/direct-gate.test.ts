import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookId, CharacterName, Dispatch, EventId, HookId, ThreadId } from "../../novel/types";
import { validateDispatch } from "../../novel/gates/dispatch-gate";
import type { DispatchGateLedgerEntry } from "../../novel/gates/dispatch-gate";
import { buildFakeBookRuntime } from "../../novel/runtime";
import type { AgentGenerateInput, AgentPort } from "../agent-port";
import { StubAgent } from "../stub-agent";
import { ChapterWorkflow } from "../engine";
import { withDispatchGate } from "../direct-gate";
import { createDirectNode } from "../nodes/direct";
import type { StepNode, StepRunContext, WorkflowEvent, WorkflowStore, PersistedWorkflow } from "../types";

/* 编译期断言：包装器仍产出 StepNode<'direct'>，其 output 仍为 Dispatch。 */
type Expect<T extends true> = T;
type _gatedDirect = Expect<ReturnType<typeof withDispatchGate> extends StepNode<"direct"> ? true : false>;

const H007 = "H007" as HookId;
const H011 = "H011" as HookId;
const bookId = "book-gate-001" as BookId;
const chapter = 21;

/** 账本视图：H007（已埋设、已推进、可回收）、H011（已埋设、可推进）。 */
const ledger: Readonly<Record<HookId, DispatchGateLedgerEntry>> = {
  [H007]: { status: "progressing", startChapter: 2, lastAdvancedChapter: 19, coreHook: true },
  [H011]: { status: "open", startChapter: 5, lastAdvancedChapter: 10, coreHook: false },
};

/** 债务表视图：mustResolve=H007、mustAdvance=H011，允许开新。 */
const context = {
  mustResolve: [H007],
  mustAdvance: [H011],
  canResolve: [],
  canAdvance: [],
  mustNotDefer: [H007],
  pressure: {},
  staleDebt: [],
  budget: { activeCount: 3, cap: 12, openAllowed: true },
};

/** 合规 Dispatch（同 §7.7 实例）：resolve H007、advance H011。 */
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

/** 真实闸门：直接引用 §5.3 validateDispatch。 */
const judge = (output: Dispatch, _ctx: StepRunContext) => validateDispatch({ dispatch: output, context, ledger });

function directNode(output: Dispatch): StepNode<"direct"> {
  return { step: "direct", run: async () => ({ outcome: { kind: "continue" }, output }) };
}

/** 内存存储替身。 */
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
}

test("合规 Dispatch：经 withDispatchGate 后 continue，产物原样保留", async () => {
  const dispatch = makeDispatch();
  const gated = withDispatchGate(directNode(dispatch), judge);
  const result = await gated.run({ bookId, chapter, state: { bookId, chapter, step: "direct" as const, status: "planned" as const, retries: 0 }, artifacts: {} });
  assert.deepEqual(result.outcome, { kind: "continue" });
  assert.deepEqual(result.output, dispatch);
});

test("违规 Dispatch（mustResolve 未覆盖）：返回 retry 回 direct，reason 含违规规则", async () => {
  const bad = makeDispatch({ hookDirectives: { ...makeDispatch().hookDirectives, resolve: [] } });
  const gated = withDispatchGate(directNode(bad), judge);
  const result = await gated.run({ bookId, chapter, state: { bookId, chapter, step: "direct" as const, status: "planned" as const, retries: 0 }, artifacts: {} });
  assert.equal(result.outcome.kind, "retry");
  if (result.outcome.kind !== "retry") return;
  assert.equal(result.outcome.step, "direct");
  assert.match(result.outcome.reason, /must-resolve-not-covered/);
});

test("节点自带的 suspend/fail/无产物结果原样透传，不触发闸门", async () => {
  const suspending: StepNode<"direct"> = {
    step: "direct",
    run: async () => ({ outcome: { kind: "suspend", reason: "等人类确认主角人设" } }),
  };
  const gated = withDispatchGate(suspending, judge);
  const result = await gated.run({ bookId, chapter, state: { bookId, chapter, step: "direct" as const, status: "planned" as const, retries: 0 }, artifacts: {} });
  assert.deepEqual(result.outcome, { kind: "suspend", reason: "等人类确认主角人设" });
});

test("引擎集成：闸门拒绝 → retry 回 direct，预算耗尽后挂起并通知", async () => {
  const bad = makeDispatch({ hookDirectives: { ...makeDispatch().hookDirectives, resolve: [] } });
  const events: WorkflowEvent[] = [];
  const workflow = new ChapterWorkflow({
    nodes: [withDispatchGate(directNode(bad), judge)],
    store: new MemoryStore(),
    maxRetries: 2,
    notify: (e) => events.push(e),
  });
  const result = await workflow.run(bookId, chapter);
  assert.equal(result.kind, "suspended");
  if (result.kind !== "suspended") return;
  assert.match(result.reason, /Dispatch 未通过校验闸门/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["retrying", "retrying", "suspended"],
  );
});

/** 记录传给 agent 的原始输入（真实 agent 接入后用于核对指令与上下文）。 */
class RecordingAgent implements AgentPort {
  readonly inputs: AgentGenerateInput[] = [];
  constructor(private readonly inner: AgentPort) {}
  async generate(input: AgentGenerateInput) {
    this.inputs.push(input);
    return this.inner.generate(input);
  }
}

test("direct 节点：instruction 含 Dispatch 结构示例（few-shot），context 注入线程快照", async () => {
  const runtime = buildFakeBookRuntime();
  const stub = new StubAgent([{ task: "direct", responses: [{ json: makeDispatch({ chapter: 1 }) }] }]);
  const recorder = new RecordingAgent(stub);
  const node = createDirectNode(recorder, { runtime });
  const ctx: StepRunContext = {
    bookId,
    chapter: 1,
    state: { bookId, chapter: 1, step: "direct" as const, status: "planned" as const, retries: 0 },
    artifacts: {},
  };
  const result = await node.run(ctx);
  assert.equal(result.outcome.kind, "continue");
  const input = recorder.inputs[0];
  assert.match(input.instruction, /"castPlan"/);
  assert.match(input.instruction, /"hookDirectives"/);
  assert.match(input.instruction, /禁止额外包装键/);
  const parsed = JSON.parse(input.context) as { threads?: Record<string, unknown>; chapter?: number };
  assert.equal(parsed.chapter, 1);
  assert.ok(parsed.threads?.["tl-main-share"] !== undefined, "context 应含线程快照");
});
