import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NovelId } from "../../novel/types";
import type { PersistedWorkflow } from "../types";
import { createJsonFileStore } from "../file-store";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fly-novel-store-"));
  return dir;
}

const NOVEL_A = "novel-alpha" as NovelId;
const NOVEL_B = "novel-beta" as NovelId;

const record: PersistedWorkflow = {
  novelId: NOVEL_A,
  chapter: 3,
  state: { novelId: NOVEL_A, chapter: 3, step: "write", status: "drafted", retries: 1 },
  artifacts: { direct: { chapter: 3, goal: "g", castPlan: [], threadPlan: [], hookDirectives: { open: [], advance: [], resolve: [], defer: [], mention: [] }, styleNotes: [], budget: { scenes: 4, chars: 5 } } },
};

test("JsonFileStore：save 后 load 原样回读（断点续跑数据完整）", async () => {
  const dir = await tempDir();
  try {
    const store = createJsonFileStore({ dir });
    await store.save(record);
    const loaded = await store.load(NOVEL_A, 3);
    assert.deepEqual(loaded, record);
    // 磁盘布局：{dir}/{chapter}.json
    const raw = await readFile(join(dir, "3.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), record);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore：load 不存在的章 → undefined（引擎按新章从头跑）", async () => {
  const dir = await tempDir();
  try {
    const store = createJsonFileStore({ dir });
    assert.equal(await store.load(NOVEL_A, 99), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore：重复 save 覆盖旧记录（重跑章节不残留旧章文件）", async () => {
  const dir = await tempDir();
  try {
    const store = createJsonFileStore({ dir });
    await store.save(record);
    const updated: PersistedWorkflow = { ...record, state: { ...record.state, status: "settled", step: "settle" } };
    await store.save(updated);
    const loaded = await store.load(NOVEL_A, 3);
    assert.equal(loaded?.state.status, "settled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore：章节目录直接存放文件并拒绝小说标识冲突", async () => {
  const dir = await tempDir();
  try {
    const store = createJsonFileStore({ dir });
    await store.save(record);
    await assert.rejects(store.save({ ...record, novelId: NOVEL_B }));
    assert.deepEqual(await store.load(NOVEL_A, 3), record);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
