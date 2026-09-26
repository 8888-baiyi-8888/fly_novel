import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import {
  CharacterAgent,
  CharacterMemory,
  configureAgentRuntime,
} from "@fly-novel/agents";
import type { CharacterAgentRunInput } from "@fly-novel/agents";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");
const { FakeListChatModel: BaseFakeListChatModel }: typeof import("@langchain/core/utils/testing") = requireFromAgentsPackage("@langchain/core/utils/testing");
const { AIMessage }: typeof import("@langchain/core/messages") = requireFromAgentsPackage("@langchain/core/messages");
const { z }: typeof import("zod") = requireFromAgentsPackage("zod");
const performanceSchema = z.strictObject({ performance: z.string() }).meta({ title: "character_response" });
const testDataDirectory = join(process.cwd(), "src/agents/tests/fixtures/data");

function configureTestAgentRuntime(
  runtime: Partial<Parameters<typeof configureAgentRuntime>[0]> = {},
): void {
  configureAgentRuntime({
    characterDataDirectory: testDataDirectory,
    ...runtime,
    resolveModel: runtime.resolveModel ?? (() => { throw new Error("尚未配置模型解析器"); }),
  });
}

class FakeListChatModel extends BaseFakeListChatModel {
  private outputFields: string[] = [];
  private outputName = "";
  override bindTools(tools: unknown[], options?: this["ParsedCallOptions"]): this {
    // 结构化输出必须调用工具，避免模型改为普通文本回答。
    assert.equal(options?.tool_choice, "required");
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

test("角色 Agent 固定外部身份并在未配置运行时时拒绝", async () => {
  configureTestAgentRuntime();
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
    agent.run({ sceneId: "scene-ferry", scene: { location: "渡口" }, responseFormat: performanceSchema }),
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

test("角色记忆按小说、分支、角色和场景隔离，并可由新实例读取", async (t) => {
  const memoryDirectory = await mkdtemp(join(tmpdir(), "fly-novel-character-memory-"));
  t.after(async () => { await rm(memoryDirectory, { recursive: true, force: true }); });
  configureTestAgentRuntime({
    characterMemoryDirectory: memoryDirectory,
    resolveModel: () => new FakeListChatModel({ responses: ["记住了。"] }),
  });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  await agent.run({ sceneId: "scene-ferry", scene: { location: "渡口" }, responseFormat: performanceSchema });
  const memories = await CharacterMemory.getAllMemories({ storyId: "story", branchId: "main", characterId: "lin" });
  assert.deepEqual(memories, [{
    createdAt: memories[0]?.createdAt,
    sceneId: "scene-ferry",
    input: { location: "渡口" },
    output: { performance: "记住了。" },
  }]);
  assert.deepEqual(
    JSON.parse(await readFile(join(memoryDirectory, "story", "character_agent", "main", "lin", "memory", "scene-ferry.json"), "utf8")),
    { records: [memories[0]] },
  );
  const recovered = await CharacterMemory.getAllMemories({ storyId: "another-story", branchId: "main", characterId: "lin" });
  assert.deepEqual(recovered, []);
  const differentBranch = await CharacterMemory.getAllMemories({ storyId: "story", branchId: "alternate", characterId: "lin" });
  assert.deepEqual(differentBranch, []);
  await agent.run({ sceneId: "scene-inn", scene: { location: "客栈" }, responseFormat: performanceSchema });
  assert.equal((await CharacterMemory.getAllMemories({ storyId: "story", branchId: "main", characterId: "lin" })).length, 2);
});

test("每轮从角色记忆重建历史，不保留实例内会话", async (t) => {
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
  const memoryDirectory = await mkdtemp(join(tmpdir(), "fly-novel-character-memory-"));
  configureTestAgentRuntime({
    characterMemoryDirectory: memoryDirectory,
    resolveModel() { resolutions++; return model; },
  });
  t.after(() => configureAgentRuntime(undefined));
  t.after(async () => { await rm(memoryDirectory, { recursive: true, force: true }); });
  const identity = { storyId: "story", characterId: "lin" };
  const agent = new CharacterAgent(identity);
  const input: CharacterAgentRunInput = {
    sceneId: "scene-ferry", scene: { location: "渡口" }, responseFormat: performanceSchema,
  };
  const controller = new AbortController();
  const first = await agent.run(input);
  const second = await agent.run({ ...input, sceneId: "scene-inn", scene: { location: "客栈" } }, { signal: controller.signal });
  assert.equal(resolutions, 2);
  assert.equal(create.mock.callCount(), 2);
  assert.equal(first.messages.filter((m: BaseMessage) => m.type === "human").length, 1);
  assert.equal(second.messages.filter((m: BaseMessage) => m.type === "human").length, 2);
  assert.ok(model.seen[1]?.some(message => typeof message.content === "string" && message.content.includes("我会回来。")));
  assert.ok(model.seen[1]?.some(message => typeof message.content === "string" && message.content.includes("渡口")));
  const fresh = await new CharacterAgent(identity).run({ ...input, scene: { location: "新场景" } });
  assert.equal(fresh.messages.filter((m: BaseMessage) => m.type === "human").length, 3);
  assert.ok(model.seen[2]?.some(message => typeof message.content === "string" && message.content.includes("我会回来。")));
  assert.equal(create.mock.callCount(), 3);
});

test("同一会话拒绝并发调用，取消初始化后可重新运行", async (t) => {
  const model = new FakeListChatModel({ responses: ["继续。"] });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let resolutions = 0;
  configureTestAgentRuntime({ async resolveModel() {
    resolutions++;
    entered();
    await gate;
    return model;
  } });
  t.after(() => configureAgentRuntime(undefined));
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { sceneId: "scene", scene: {}, responseFormat: performanceSchema };
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
  configureTestAgentRuntime({ resolveModel() {
    calls++;
    if (calls === 1) throw new Error("模型解析失败");
    return new FakeListChatModel({ responses: ["成功。"] });
  } });
  t.after(() => configureAgentRuntime(undefined));
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { sceneId: "scene", scene: {}, responseFormat: performanceSchema };
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

test("每轮通过 Schema 切换输出字段，并从记忆保留历史", async (t) => {
  const create = t.mock.method(deepagents, "createDeepAgent");
  const model = new FakeListChatModel({ responses: ["第一轮", "第二轮", "第三轮"] });
  const memoryDirectory = await mkdtemp(join(tmpdir(), "fly-novel-character-memory-"));
  t.after(async () => { await rm(memoryDirectory, { recursive: true, force: true }); });
  configureTestAgentRuntime({ characterMemoryDirectory: memoryDirectory, resolveModel: () => model });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const first = await agent.run({ sceneId: "scene", scene: {}, responseFormat: performanceSchema });
  assert.deepEqual(first.structuredResponse, { performance: "第一轮" });
  const second = await agent.run({ sceneId: "scene", scene: {}, responseFormat: z.strictObject({ innerActivity: z.string() }).meta({ title: "character_response" }) });
  assert.deepEqual(second.structuredResponse, { innerActivity: "第二轮" });
  assert.ok(second.messages.some((m: BaseMessage) => m.text.includes("第一轮")));
  const third = await agent.run({ sceneId: "scene", scene: {}, responseFormat: z.strictObject({ stateChanges: z.array(z.string()) }).meta({ title: "character_response" }) });
  assert.deepEqual(third.structuredResponse, { stateChanges: [] });
  assert.equal(create.mock.callCount(), 3);
});

test("缺失字段、错误类型和额外字段均拒绝，后续调用可以恢复", async () => {
  let response: Record<string, unknown> = {};
  const model = new ScriptedChatModel(() => new AIMessage({ content: "", tool_calls: [{
    id: "invalid", name: "character_response", args: response,
  }] }));
  configureTestAgentRuntime({ resolveModel: () => model });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { sceneId: "scene", scene: {}, responseFormat: performanceSchema };
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
  configureTestAgentRuntime({ resolveModel: () => new SometimesPlainModel({ responses: ["上一轮"] }) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const input: CharacterAgentRunInput = { sceneId: "scene", scene: {}, responseFormat: performanceSchema };
  assert.deepEqual((await agent.run(input)).structuredResponse, { performance: "上一轮" });
  plain = true;
  await assert.rejects(agent.run(input));
});

test("缺失或无效 Schema 在初始化模型前拒绝", async () => {
  let calls = 0;
  configureTestAgentRuntime({ resolveModel() { calls++; return new FakeListChatModel({ responses: ["未调用"] }); } });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  for (const json of ['null', '{}', '"performance"']) {
    await assert.rejects(agent.run({ sceneId: "scene", scene: {}, responseFormat: JSON.parse(json) }), /Zod 对象 Schema/);
  }
  await assert.rejects(agent.run(JSON.parse('{"sceneId":"scene","scene":{}}')), /Zod 对象 Schema/);
  assert.equal(calls, 0);
});

test("调用方定义任意字段、嵌套类型及必需项，返回类型从 Schema 推导", async () => {
  const responseFormat = z.strictObject({
    spokenWords: z.array(z.string()),
    decision: z.strictObject({ shouldWait: z.boolean(), priority: z.number().int() }),
    note: z.string().optional(),
  }).meta({ title: "custom_response" });
  const response = { spokenWords: ["我等你"], decision: { shouldWait: true, priority: 2 } };
  configureTestAgentRuntime({ resolveModel: () => new ScriptedChatModel(() => new AIMessage({
    content: "", tool_calls: [{ id: "custom", name: "custom_response", args: response }],
  })) });
  const result = await new CharacterAgent({ storyId: "story", characterId: "lin" }).run({ sceneId: "scene", scene: {}, responseFormat });
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
  configureTestAgentRuntime({ resolveModel: () => new FakeListChatModel({ responses: ["任意回复"] }) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  const result = await agent.run({ sceneId: "scene", scene: {}, responseFormat: z.object({ reply: z.string() }) });
  assert.equal(result.structuredResponse.reply, "任意回复");
});

test("额外字段拒绝或保留由调用方 Schema 决定", async () => {
  const response = { reply: "回答", extra: 42 };
  configureTestAgentRuntime({ resolveModel: () => new ScriptedChatModel(() => new AIMessage({
    content: "", tool_calls: [{ id: "custom", name: "custom_response", args: response }],
  })) });
  const agent = new CharacterAgent({ storyId: "story", characterId: "lin" });
  await assert.rejects(agent.run({ sceneId: "scene", scene: {}, responseFormat: z.strictObject({ reply: z.string() }).meta({ title: "custom_response" }) }));
  const retained = await agent.run({ sceneId: "scene", scene: {}, responseFormat: z.looseObject({ reply: z.string() }).meta({ title: "custom_response" }) });
  assert.deepEqual(retained.structuredResponse, response);
});
