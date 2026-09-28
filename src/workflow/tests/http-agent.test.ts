import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentGenerateInput, AgentPort } from "../agent-port";
import { createHttpAgent } from "../http-agent";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const input: AgentGenerateInput = { task: "direct", instruction: "i", context: "c", outputFormat: "json" };

test("HttpAgent：成功响应含 json 字段 → 原样返回", async () => {
  const agent = createHttpAgent({
    baseUrl: "https://agent.example.com/",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://agent.example.com/generate");
      assert.equal((init.headers as Record<string, string>)["content-type"], "application/json");
      assert.equal(init.body, JSON.stringify(input));
      return jsonResponse(200, { text: "ok", json: { chapter: 21 } });
    },
  });
  const out = await agent.generate(input);
  assert.equal(out.text, "ok");
  assert.deepEqual(out.json, { chapter: 21 });
});

test("HttpAgent：响应缺 json（text-only）→ 只返回 text", async () => {
  const agent = createHttpAgent({ baseUrl: "https://agent.example.com", fetchImpl: async () => jsonResponse(200, { text: "正文……" }) });
  const out = await agent.generate(input);
  assert.equal(out.text, "正文……");
  assert.equal(out.json, undefined);
});

test("HttpAgent：apiKey 写入 authorization 头", async () => {
  const agent = createHttpAgent({
    baseUrl: "https://agent.example.com",
    apiKey: "Bearer secret",
    fetchImpl: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer secret");
      return jsonResponse(200, { text: "ok" });
    },
  });
  await agent.generate(input);
});

test("HttpAgent：非 2xx → 抛错（节点经 runAgentTask 转 fail）", async () => {
  const agent = createHttpAgent({ baseUrl: "https://agent.example.com", fetchImpl: async () => jsonResponse(500, { error: "boom" }) });
  await assert.rejects(() => agent.generate(input), /500/);
});

test("HttpAgent：响应缺 text → 抛错", async () => {
  const agent = createHttpAgent({ baseUrl: "https://agent.example.com", fetchImpl: async () => jsonResponse(200, { json: {} }) });
  await assert.rejects(() => agent.generate(input), /text 字段/);
});

test("HttpAgent：超时 → 抛错（AbortSignal 触发）", async () => {
  const agent = createHttpAgent({
    baseUrl: "https://agent.example.com",
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return jsonResponse(200, { text: "ok" });
    },
  });
  await assert.rejects(() => agent.generate(input), /aborted/);
});
