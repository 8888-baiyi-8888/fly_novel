import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import {
  CharacterAgent,
  configureAgentRuntime,
} from "@fly-novel/agents";
import type { CharacterContextSection } from "@fly-novel/agents";
import type { CharacterAgentRunInput } from "@fly-novel/agents";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");
const { FakeListChatModel: BaseFakeListChatModel }: typeof import("@langchain/core/utils/testing") = requireFromAgentsPackage("@langchain/core/utils/testing");
const { MemorySaver }: typeof import("@langchain/langgraph-checkpoint") = requireFromAgentsPackage("@langchain/langgraph-checkpoint");
const { AIMessage }: typeof import("@langchain/core/messages") = requireFromAgentsPackage("@langchain/core/messages");
const { z }: typeof import("zod") = requireFromAgentsPackage("zod");
const performanceSchema = z.strictObject({ performance: z.string() }).meta({ title: "character_response" });

class FakeListChatModel extends BaseFakeListChatModel {
  private outputFields: string[] = [];
  private outputName = "";
  override bindTools(tools: unknown[], options?: this["ParsedCallOptions"]): this {
    // 在真实框架的模型边界拒绝导致 DeepSeek 思考模式报错的强制工具选择。
    assert.equal(options?.tool_choice, "auto");
    const format = z.object({ type: z.literal("function"), function: z.object({
      name: z.string().regex(/^(character_response|custom_response|extract-\d+)$/),
      parameters: z.object({ properties: z.record(z.string(), z.unknown()) }),
    }) });
    for (const tool of tools) {
      const parsed = format.safeParse(tool);
      assert.ok(parsed.success, "模型只能收到结构化输出工具");
      if (parsed.success) {
        this.outputFields = Object.keys(parsed.data.function.parameters.properties);
        this.outputName = parsed.data.function.name;
      }
    }
    assert.ok(this.outputFields.length > 0);
    return this;
  }
  protected formatResponse(message: InstanceType<typeof AIMessage>) {
    if (message.tool_calls?.length) return message;
    return new AIMessage({ content: message.content, tool_calls: [{
      id: `response-${this.i}`, name: this.outputName,
      args: Object.fromEntries(this.outputFields.map(field => [field, field === "stateChanges" ? [] : message.text])),
    }] });
  }
  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const result = await super._generate(messages, options);
    const message = result.generations[0]?.message;
    assert.ok(message && AIMessage.isInstance(message));
    return { generations: [{ text: message.text, message: this.formatResponse(message) }] };
  }
}

afterEach(() => configureAgentRuntime(undefined));

class CharacterAgentProbe extends CharacterAgent {
  public prompt(input: CharacterAgentRunInput): Promise<string> {
    return this.buildModelPrompt(input);
  }
  public combine(results: readonly CharacterContextSection[]): string {
    return this.combineContext(results);
  }
}

test("内部资料先于外部场景拼接，空资料不产生占位文本", async () => {
  class PreparedAgent extends CharacterAgentProbe {
    protected override async loadProfile(): Promise<CharacterContextSection> {
      return { content: "人物：林舟" };
    }
    protected override async loadPersonality(): Promise<CharacterContextSection> {
      return { content: "性格：谨慎" };
    }
  }
  const agent = new PreparedAgent({ storyId: "story", characterId: "lin" });
  assert.equal(await agent.prompt({
    scene: { location: "渡口" },
    responseFormat: z.strictObject({ performance: z.string(), innerActivity: z.string() }).meta({ title: "character_response" }),
  }), '人物：林舟\n\n性格：谨慎\n\n场景：{"location":"渡口"}');
  assert.equal(agent.combine([{ content: " " }, { content: "\n" }]), "");
});

test("角色 Agent 固定外部身份并在未配置运行时时拒绝", async () => {
  configureAgentRuntime(undefined);
  const agent = new CharacterAgent({
    modelId: "default",
    storyId: "novel-river",
    branchId: "main",
    characterId: "character-lin-zhou",
  });

  assert.deepEqual(agent.options, {
    modelId: "default",
    storyId: "novel-river",
    branchId: "main",
    characterId: "character-lin-zhou",
  });
  await assert.rejects(
    agent.run({ scene: { location: "渡口" }, responseFormat: performanceSchema }),
    /尚未配置模型解析器/,
  );
});

test("角色 Agent 拒绝空的外部身份标识", () => {
  assert.throws(
    () => new CharacterAgent({ storyId: " ", characterId: "character-lin-zhou" }),
    /storyId 必须是非空字符串/,
  );
  assert.throws(
    () => new CharacterAgent({ modelId: "", storyId: "novel-river", characterId: "character-lin-zhou" }),
    /modelId 必须是非空字符串/,
  );
});

test("角色子功能只拼接有内容的片段并保留顺序", () => {
  const agent = new CharacterAgentProbe({
    storyId: "novel-river",
    characterId: "character-lin-zhou",
  });
  assert.equal(agent.combine([
    { content: "人物设定" },
    { content: "" },
    { content: "  " },
    { content: "场景" },
  ]), "人物设定\n\n场景");
});

test("框架检查点延续本实例历史，新实例即使身份相同也不共享会话", async (t) => {
  class RecordingModel extends FakeListChatModel {
    readonly seen: BaseMessage[][] = [];
    override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
      this.seen.push(messages);
      return super._generate(messages, options);
    }
  }
  const model = new RecordingModel({ responses: ["我会回来。", "记得渡口的约定。", "新的会话。"] });
  const create = t.mock.method(deepagents, "createDeepAgent");
  let resolutions = 0;
  configureAgentRuntime({ resolveModel() { resolutions++; return model; } });
  t.after(() => configureAgentRuntime(undefined));
  const identity = { storyId: "story", characterId: "lin" };
  const agent = new CharacterAgent(identity);
  const input: CharacterAgentRunInput = {
    scene: { location: "渡口" }, responseFormat: performanceSchema,
  };
  const controller = new AbortController();
  const first = await agent.run(input);
  const created = create.mock.calls[0];
  assert.ok(created?.result);
  const second = await agent.run({ ...input, scene: { location: "客栈" } }, { signal: controller.signal });
  assert.equal(resolutions, 1);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(first.messages.filter((m: BaseMessage) => m.type === "human").length, 1);
  assert.equal(second.messages.filter((m: BaseMessage) => m.type === "human").length, 2);
  assert.ok(model.seen[1]?.some(message => message.content === "我会回来。"));
  assert.ok(model.seen[1]?.some(message => typeof message.content === "string" && message.content.includes("渡口")));
  assert.ok(created.arguments[0]?.checkpointer instanceof MemorySaver);
  assert.equal(created.arguments[0]?.memory, undefined);
  assert.equal(created.arguments[0]?.backend, undefined);
  const fresh = await new CharacterAgent(identity).run({ ...input, scene: { location: "新场景" } });
  assert.equal(fresh.messages.filter((m: BaseMessage) => m.type === "human").length, 1);
  assert.ok(!model.seen[2]?.some(message => message.content === "我会回来。"));
  assert.notEqual(create.mock.calls[1]?.arguments[0]?.checkpointer, created.arguments[0]?.checkpointer);
});

test("同一会话拒绝并发调用，取消初始化后可重新运行", async (t) => {
  const model = new FakeListChatModel({ responses: ["继续。"] });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let resolutions = 0;
  configureAgentRuntime({ async resolveModel() {
    resolutions++;
    entered();
    await gate;
    return model;
  } });
  t.after(() => configureAgentRuntime(undefined));
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { scene: {}, responseFormat: performanceSchema };
  const controller = new AbortController();
  const cancelled = agent.run(input, { signal: controller.signal });
  await started;
  await assert.rejects(agent.run(input), /不允许并发/);
  controller.abort();
  release();
  await assert.rejects(cancelled, { name: "AbortError" });
  const result = await agent.run(input);
  assert.equal(resolutions, 2);
  assert.equal(result.messages.filter((m: BaseMessage) => m.type === "human").length, 1);
});

test("模型解析失败后释放运行状态，预取消不解析模型", async (t) => {
  let calls = 0;
  configureAgentRuntime({ resolveModel() {
    calls++;
    if (calls === 1) throw new Error("模型解析失败");
    return new FakeListChatModel({ responses: ["成功。"] });
  } });
  t.after(() => configureAgentRuntime(undefined));
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { scene: {}, responseFormat: performanceSchema };
  await assert.rejects(agent.run(input, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(agent.run(input), /模型解析失败/);
  assert.equal((await agent.run(input)).structuredResponse.performance, "成功。");
});

/** 通过真实框架执行预定工具调用，避免网络依赖和不确定的模型选择。 */
class ScriptedChatModel extends FakeListChatModel {
  constructor(private readonly respond: (messages: BaseMessage[]) => InstanceType<typeof AIMessage>) {
    super({ responses: ["unused"] });
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.formatResponse(this.respond(messages));
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] };
  }
}

test("每轮通过 Schema 切换输出字段，复用 Agent 并保留历史", async (t) => {
  const create = t.mock.method(deepagents, "createDeepAgent");
  const model = new FakeListChatModel({ responses: ["第一轮", "第二轮", "第三轮"] });
  configureAgentRuntime({ resolveModel: () => model });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const first = await agent.run({ scene: {}, responseFormat: performanceSchema });
  assert.deepEqual(first.structuredResponse, { performance: "第一轮" });
  const second = await agent.run({ scene: {}, responseFormat: z.strictObject({ innerActivity: z.string() }).meta({ title: "character_response" }) });
  assert.deepEqual(second.structuredResponse, { innerActivity: "第二轮" });
  assert.ok(second.messages.some((m: BaseMessage) => m.text === "第一轮"));
  const third = await agent.run({ scene: {}, responseFormat: z.strictObject({ stateChanges: z.array(z.string()) }).meta({ title: "character_response" }) });
  assert.deepEqual(third.structuredResponse, { stateChanges: [] });
  assert.equal(create.mock.callCount(), 1);
});

test("缺失字段、错误类型和额外字段均拒绝，后续调用可以恢复", async () => {
  let response: Record<string, unknown> = {};
  const model = new ScriptedChatModel(() => new AIMessage({ content: "", tool_calls: [{
    id: "invalid", name: "character_response", args: response,
  }] }));
  configureAgentRuntime({ resolveModel: () => model });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { scene: {}, responseFormat: performanceSchema };
  for (const invalid of [{}, { performance: 42 }, { performance: "有效", innerActivity: "未选择" }]) {
    response = invalid;
    await assert.rejects(agent.run(input));
  }
  response = { performance: "恢复" };
  assert.deepEqual((await agent.run(input)).structuredResponse, response);
});

test("新一轮未生成结构化结果时不能返回上一轮结果", async () => {
  let plain = false;
  class SometimesPlainModel extends FakeListChatModel {
    override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
      if (plain) return { generations: [{ text: "只有文本", message: new AIMessage("只有文本") }] };
      return super._generate(messages, options);
    }
  }
  configureAgentRuntime({ resolveModel: () => new SometimesPlainModel({ responses: ["上一轮"] }) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { scene: {}, responseFormat: performanceSchema };
  assert.deepEqual((await agent.run(input)).structuredResponse, { performance: "上一轮" });
  plain = true;
  await assert.rejects(agent.run(input));
});

test("缺失或无效 Schema 在初始化模型前拒绝", async () => {
  let calls = 0;
  configureAgentRuntime({ resolveModel() { calls++; return new FakeListChatModel({ responses: ["未调用"] }); } });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  for (const json of ['null', '{}', '"performance"']) {
    await assert.rejects(agent.run({ scene: {}, responseFormat: JSON.parse(json) }), /Zod 对象 Schema/);
  }
  await assert.rejects(agent.run(JSON.parse('{"scene":{}}')), /Zod 对象 Schema/);
  assert.equal(calls, 0);
});

test("调用方定义任意字段、嵌套类型及必需项，返回类型从 Schema 推导", async () => {
  const responseFormat = z.strictObject({
    spokenWords: z.array(z.string()),
    decision: z.strictObject({ shouldWait: z.boolean(), priority: z.number().int() }),
    note: z.string().optional(),
  }).meta({ title: "custom_response" });
  const response = { spokenWords: ["我等你"], decision: { shouldWait: true, priority: 2 } };
  configureAgentRuntime({ resolveModel: () => new ScriptedChatModel(() => new AIMessage({
    content: "", tool_calls: [{ id: "custom", name: "custom_response", args: response }],
  })) });
  const result = await new CharacterAgent({ storyId: "story", characterId: "lin" }).run({ scene: {}, responseFormat });
  const words: string[] = result.structuredResponse.spokenWords;
  const shouldWait: boolean = result.structuredResponse.decision.shouldWait;
  const priority: number = result.structuredResponse.decision.priority;
  const note: string | undefined = result.structuredResponse.note;
  assert.deepEqual(words, response.spokenWords);
  assert.equal(shouldWait, true);
  assert.equal(priority, 2);
  assert.equal(note, undefined);
  assert.deepEqual(result.structuredResponse, response);
});

test("调用方无需指定 Schema 标题", async () => {
  configureAgentRuntime({ resolveModel: () => new FakeListChatModel({ responses: ["任意回复"] }) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const result = await agent.run({ scene: {}, responseFormat: z.object({ reply: z.string() }) });
  assert.equal(result.structuredResponse.reply, "任意回复");
});

test("额外字段拒绝或保留由调用方 Schema 决定", async () => {
  const response = { reply: "回答", extra: 42 };
  configureAgentRuntime({ resolveModel: () => new ScriptedChatModel(() => new AIMessage({
    content: "", tool_calls: [{ id: "custom", name: "custom_response", args: response }],
  })) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  await assert.rejects(agent.run({ scene: {}, responseFormat: z.strictObject({ reply: z.string() }).meta({ title: "custom_response" }) }));
  const retained = await agent.run({ scene: {}, responseFormat: z.looseObject({ reply: z.string() }).meta({ title: "custom_response" }) });
  assert.deepEqual(retained.structuredResponse, response);
});
