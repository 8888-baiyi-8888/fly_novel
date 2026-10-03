import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as credentials from "../credentials";
import { APP_HOME } from "../paths";
import { readSettings } from "../settings";

test("普通设置使用固定路径，每次读取配置且不解密凭据", async (t) => {
  let settings: unknown = { deepseek: {
    baseURL: "https://example.test", model: "test-model", credentialRef: "DEEPSEEK_API_KEY",
  } };
  let malformed = false;
  let keyReads = 0;
  const decryptMock = t.mock.method(credentials, "decryptSecret", () => {
    throw new Error("不应解密");
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
  settings = { deepseek: { model: "updated-model" } };
  assert.deepEqual((await readSettings()).settings, settings);
  assert.equal((await readSettings()).credentials.DEEPSEEK_API_KEY, "test-ciphertext");
  assert.equal(decryptMock.mock.callCount(), 0);
  assert.equal(keyReads, 0);
  malformed = true;
  await assert.rejects(readSettings(), /not valid JSON/);
  malformed = false;
  settings = [];
  await assert.rejects(readSettings(), /configuration object/);
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
