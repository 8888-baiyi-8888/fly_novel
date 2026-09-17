import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { callConfiguredDeepSeek } from "../../app/call-deepseek";
import * as credentials from "../credentials";
import { APP_HOME } from "../paths";
import { readSettings } from "../settings";

test("普通设置使用固定路径，每次请求读取配置并使用解密后的凭据", async (t) => {
  let settings: unknown = { deepseek: {
    baseURL: "https://example.test", model: "test-model", credentialRef: "DEEPSEEK_API_KEY",
  } };
  let secret = "test-key";
  let credentialError = false;
  let malformed = false;
  let keyReads = 0;
  const decryptMock = t.mock.method(credentials, "decryptSecret", (value: string, key: string) => {
    assert.equal(value, "test-ciphertext");
    assert.equal(key, "a".repeat(64));
    if (credentialError) throw new Error("Credential decryption failed");
    return secret;
  });
  t.mock.method(fs, "readFile", async (path: string) => {
    if (path === join(APP_HOME, ".encryption-key")) {
      keyReads++;
      return "a".repeat(64) + "\r\n";
    }
    if (path === join(APP_HOME, ".credentials.json")) return JSON.stringify({ refs: { DEEPSEEK_API_KEY: "test-ciphertext" } });
    assert.equal(path, join(APP_HOME, "settings.json"));
    return malformed ? "{" : JSON.stringify(settings);
  });
  const cwd = process.cwd();
  try {
    process.chdir(join(APP_HOME, "..", "src"));
    assert.deepEqual(await readSettings(), {
      settings,
      credentials: { DEEPSEEK_API_KEY: "test-ciphertext" },
    });
  } finally { process.chdir(cwd); }
  secret = "updated-key";
  assert.equal((await readSettings()).credentials.DEEPSEEK_API_KEY, "test-ciphertext");
  assert.equal(decryptMock.mock.callCount(), 0);
  assert.equal(keyReads, 0);
  let expectedModel = "test-model";
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.test/chat/completions");
    assert.deepEqual(init.headers, { Authorization: "Bearer updated-key", "Content-Type": "application/json" });
    assert.equal(JSON.parse(String(init.body)).model, expectedModel);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  assert.equal(await callConfiguredDeepSeek({ messages: [] }), "ok");
  expectedModel = "override-model";
  assert.equal(await callConfiguredDeepSeek({ messages: [], model: expectedModel }), "ok");
  credentialError = true;
  await assert.rejects(callConfiguredDeepSeek({ messages: [] }), /decryption failed/);
  assert.equal(fetchMock.mock.callCount(), 2);
  credentialError = false;
  malformed = true;
  await assert.rejects(readSettings(), /not valid JSON/);
  malformed = false;
  settings = [];
  await assert.rejects(readSettings(), /configuration object/);
  settings = { deepseek: { baseURL: "file:///tmp/key", model: "test", credentialRef: "DEEPSEEK_API_KEY" } };
  await assert.rejects(callConfiguredDeepSeek({ messages: [] }), /HTTP\(S\)/);
});

test("一次读取多个提供商及全部密文，不依赖加密密钥文件", async (t) => {
  const settings = { deepseek: { model: "test-a" }, qwen: { model: "test-b" } };
  let document: unknown = { refs: { DEEPSEEK_API_KEY: "cipher-a", QWEN_API_KEY: "cipher-b" } };
  t.mock.method(fs, "readFile", async (path: string) => {
    if (path === join(APP_HOME, "settings.json")) return JSON.stringify(settings);
    assert.equal(path, join(APP_HOME, ".credentials.json"));
    return JSON.stringify(document);
  });
  assert.deepEqual(await readSettings(), {
    settings,
    credentials: { DEEPSEEK_API_KEY: "cipher-a", QWEN_API_KEY: "cipher-b" },
  });
  document = { refs: { QWEN_API_KEY: 123 } };
  await assert.rejects(readSettings(), /must be strings/);
  document = { refs: [] };
  await assert.rejects(readSettings(), /must be an object/);
  document = null;
  await assert.rejects(readSettings(), /configuration object/);
});
