import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

async function temporaryHome(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fly-novel-init-key-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, "app-home");
}

function initialize(home: string) {
  // 在独立子进程加载入口前替换 CommonJS 路径导出，避免访问真实 APP_HOME。
  return spawnSync(process.execPath, ["-e",
    "require(process.argv[1]).APP_HOME = process.argv[2]; require(process.argv[3]);",
    require.resolve("../../config/paths"), home,
    require.resolve("../init-encryption-key")], { encoding: "utf8" });
}

test("首次初始化创建目录及合法的 32 字节密钥，不输出密钥或创建凭据", async (t) => {
  const home = await temporaryHome(t);
  const result = initialize(home);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const key = await readFile(join(home, ".encryption-key"), "utf8");
  assert.match(key, /^[a-f0-9]{64}\n$/);
  assert.equal(Buffer.from(key.trim(), "hex").length, 32);
  assert.deepEqual(await readdir(home), [".encryption-key"]);
});

test("再次初始化拒绝覆盖且保留原密钥和虚构凭据，不输出密钥", async (t) => {
  const home = await temporaryHome(t);
  await mkdir(home);
  const credentials = '{"refs":{"TEST":"fictional-ciphertext"}}\n';
  const credentialsPath = join(home, ".credentials.json");
  await writeFile(credentialsPath, credentials);
  const first = initialize(home);
  assert.ifError(first.error);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.equal(first.stderr, "");
  const keyPath = join(home, ".encryption-key");
  const original = await readFile(keyPath, "utf8");
  assert.equal(await readFile(credentialsPath, "utf8"), credentials);

  const second = initialize(home);
  assert.ifError(second.error);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(second.stdout, "");
  assert.ok(!second.stderr.includes(original.trim()));
  assert.equal(await readFile(keyPath, "utf8"), original);
  assert.equal(await readFile(credentialsPath, "utf8"), credentials);
});
