import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentGenerateInput } from "../agent-port";
import { createOpenAICompatibleAgent } from "../openai-compatible-agent";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chat(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

const input: AgentGenerateInput = { task: "direct", instruction: "你是导演", context: "债务表…", outputFormat: "json" };

test("OpenAICompatibleAgent：instruction→system、context→user，URL 拼 /chat/completions，返回 text", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://xxx.maas.aliyuncs.com/compatible-mode/v1/",
    apiKey: "sk-test",
    model: "qwen-plus",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://xxx.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.messages, [
        { role: "system", content: "你是导演" },
        { role: "user", content: "债务表…" },
      ]);
      assert.equal(body.model, "qwen-plus");
      assert.equal(body.enable_thinking, false);
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer sk-test");
      return jsonResponse(200, chat("好"));
    },
  });
  const out = await agent.generate({ ...input, outputFormat: undefined });
  assert.equal(out.text, "好");
  assert.equal(out.json, undefined);
});

test("OpenAICompatibleAgent：json 模式 → response_format 请求 + content 解析进 json 字段", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://xxx.maas.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-test",
    model: "m",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.response_format, { type: "json_object" });
      return jsonResponse(200, chat('{"chapter":21,"goal":"g"}'));
    },
  });
  const out = await agent.generate(input);
  assert.equal(out.text, '{"chapter":21,"goal":"g"}');
  assert.deepEqual(out.json, { chapter: 21, goal: "g" });
});

test("OpenAICompatibleAgent：jsonMode=false → 不请求 response_format；非法 JSON 不抛错只回 text", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    jsonMode: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.response_format, undefined);
      return jsonResponse(200, chat("不是 JSON"));
    },
  });
  const out = await agent.generate(input);
  assert.equal(out.text, "不是 JSON");
  assert.equal(out.json, undefined);
});

test("OpenAICompatibleAgent：temperature 透传", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    temperature: 0.3,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.temperature, 0.3);
      return jsonResponse(200, chat("ok"));
    },
  });
  await agent.generate({ ...input, outputFormat: undefined });
});

test("OpenAICompatibleAgent：非 2xx → 抛错（节点经 runAgentTask 转 fail）", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: async () => jsonResponse(401, { error: { message: "invalid api key" } }),
  });
  await assert.rejects(() => agent.generate(input), /401/);
});

test("OpenAICompatibleAgent：响应缺 choices[0].message.content → 抛错；超时 → 抛错", async () => {
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: async () => jsonResponse(200, { choices: [] }),
  });
  await assert.rejects(() => agent.generate(input), /content/);

  const slow = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return jsonResponse(200, chat("ok"));
    },
  });
  await assert.rejects(() => slow.generate(input), /aborted/);
});

test("OpenAICompatibleAgent：请求带 stream:true；SSE（event-stream）响应按 delta 累积 content", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"门轴转动，"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"雨声被隔在身后。"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.stream, true);
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const out = await agent.generate({ ...input, outputFormat: undefined });
  assert.equal(out.text, "门轴转动，雨声被隔在身后。");
  assert.equal(out.json, undefined);
});

test("OpenAICompatibleAgent：SSE 流式 + jsonMode → 累积文本解析为 json", async () => {
  const deltaValue = JSON.stringify(JSON.stringify({ chapter: 21, goal: "g" }));
  const sse = [
    'data: {"choices":[{"delta":{"content":' + deltaValue + '}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const agent = createOpenAICompatibleAgent({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const out = await agent.generate(input);
  assert.deepEqual(out.json, { chapter: 21, goal: "g" });
});
