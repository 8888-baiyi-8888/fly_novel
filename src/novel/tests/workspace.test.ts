import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildWorkspace, buildWorkspaceFiles, PLATFORM_PROFILE, resolvePlatformProfile } from "../workspace";
import { WorkspaceInputs } from "../workspace/types";
import { hooksToMd, threadsToMd, beatsByVolumeToMd, charactersToMd } from "../workspace/markdown";

import { EXAMPLE_DRAFT } from "../draft/example";
import { EXAMPLE_ARCHITECTURE } from "../architecture/example";
import { EXAMPLE_STATE0 } from "../state0/example";
import { buildExampleBookRules } from "../architect/example";
import { buildBookConfig } from "../book-config";

/** 组装一套《隐龙》N1~N6 产物（内存版）。 */
function inputs(): WorkspaceInputs {
  const draft = EXAMPLE_DRAFT;
  const bookConfig = buildBookConfig(draft);
  return {
    draft,
    bookConfig,
    storyBible: { bookId: "yinlong", title: "隐龙", sections: [{ id: "S01", title: "当代背景", content: "当代都市，江氏贸易是本地龙头企业。" }] },
    bookRules: buildExampleBookRules(),
    controls: { bookId: "yinlong", title: "隐龙", authorIntent: "信息差爽点", currentFocus: ["离婚协议逼签"], volumeDirections: [{ volume: "第一卷", direction: "借势反噬" }], constraints: ["不虐主", "不送女"] },
    architecture: EXAMPLE_ARCHITECTURE,
    state0: EXAMPLE_STATE0,
  };
}

test("N7：书目录文件清单覆盖文档目录结构（inkos/story/state/beats/空目录）", () => {
  const files = buildWorkspaceFiles(inputs());
  const relPaths = new Set(files.map((f) => f.relPath));
  assert.ok(relPaths.has("inkos.json"));
  assert.ok(relPaths.has("story/author_intent.md"));
  assert.ok(relPaths.has("story/current_focus.md"));
  assert.ok(relPaths.has("story/volume_direction.md"));
  assert.ok(relPaths.has("story/constraints.md"));
  assert.ok(relPaths.has("story/story_bible.md"));
  assert.ok(relPaths.has("story/book_rules.md"));
  assert.ok(relPaths.has("story/story_frame.md"));
  assert.ok(relPaths.has("story/volume_map.md"));
  assert.ok(relPaths.has("story/characters.md"));
  assert.ok(relPaths.has("story/hooks.md"));
  assert.ok(relPaths.has("story/hooks_archive.md"));
  assert.ok(relPaths.has("story/threads.md"));
  assert.ok(relPaths.has("story/beats/beats.json"));
  assert.ok(relPaths.has("state/hooks.json"));
  assert.ok(relPaths.has("state/threads.json"));
  assert.ok(relPaths.has("state/facts.json"));
});

test("N7：inkos.json 固化 BookConfig + 平台节奏尺子（§13.1）", () => {
  const files = buildWorkspaceFiles(inputs());
  const inkos = JSON.parse(files.find((f) => f.relPath === "inkos.json")!.content);
  assert.equal(inkos.bookId, "yinlong");
  assert.equal(inkos.bookConfig.targetChapters, EXAMPLE_DRAFT.targetChapters);
  assert.equal(inkos.platformProfile.hook.maxActive, 12);
  assert.equal(inkos.platformProfile.hook.timingMix["near-term"], 0.3);
  assert.equal(inkos.platformProfile.payoffSpacing.minor, 5);
  assert.equal(PLATFORM_PROFILE.coreHookMax, 3);
});

test("N7：按书平台选节奏尺子（晋江慢热套 / 番茄快节奏套 / 未知回退番茄）", () => {
  const jinjiang = resolvePlatformProfile("晋江");
  assert.equal(jinjiang.platform, "jinjiang");
  assert.equal(jinjiang.hook.maxActive, 10);
  assert.equal(jinjiang.hook.timingMix["slow-burn"], 0.35);
  assert.equal(jinjiang.hook.timingMix["near-term"], 0.2);
  assert.equal(jinjiang.payoffSpacing.minor, 8);
  assert.equal(jinjiang.pacing.consecutiveLowPressureMax, 3);
  assert.equal(jinjiang.coreHookMax, 4);

  const fanqie = resolvePlatformProfile("番茄");
  assert.equal(fanqie.platform, "fanqie");
  assert.equal(fanqie.hook.timingMix["near-term"], 0.3);
  assert.equal(fanqie.payoffSpacing.minor, 5);

  // 未知平台回退番茄，不崩
  const unknown = resolvePlatformProfile("起点");
  assert.equal(unknown.platform, "fanqie");

  // 晋江书 inkos.json 落晋江尺子
  const draftJj = { ...EXAMPLE_DRAFT, platform: "晋江" };
  const inputsJj = { ...inputs(), bookConfig: buildBookConfig(draftJj as typeof EXAMPLE_DRAFT) };
  const inkosJj = JSON.parse(buildWorkspaceFiles(inputsJj).find((f) => f.relPath === "inkos.json")!.content);
  assert.equal(inkosJj.platformProfile.platform, "jinjiang");
});

test("N7：hooks.md 与 state/hooks.json 是同一数据的两种投影（种子数一致）", () => {
  const files = buildWorkspaceFiles(inputs());
  const hooksMd = files.find((f) => f.relPath === "story/hooks.md")!.content;
  const hooksJson = JSON.parse(files.find((f) => f.relPath === "state/hooks.json")!.content);
  assert.equal(hooksJson.hooks.length, EXAMPLE_STATE0.hookSeeds.length);
  // 每颗种子都出现在人读表格里（以 hookId 为标记）
  for (const seed of EXAMPLE_STATE0.hookSeeds) {
    assert.ok(hooksMd.includes(seed.hookId), `hooks.md 缺少 ${seed.hookId}`);
  }
});

test("N7：threads.md 同时含逻辑层事件链与调度层状态板", () => {
  const md = threadsToMd(EXAMPLE_ARCHITECTURE.threadMap.lines, EXAMPLE_STATE0.threadBoard);
  assert.ok(md.includes("E-M01"));
  assert.ok(md.includes("线状态板"));
  assert.ok(md.includes("冷藏"));
});

test("N7：beats.json 是节拍板机器权威（100 章）", () => {
  const files = buildWorkspaceFiles(inputs());
  const beatsJson = JSON.parse(files.find((f) => f.relPath === "story/beats/beats.json")!.content);
  assert.equal(beatsJson.beats.length, EXAMPLE_ARCHITECTURE.beatBoard.beats.length);
});

test("N7：按卷节拍板投影 volume-01.md 存在且包含该卷章节", () => {
  const result = beatsByVolumeToMd(EXAMPLE_ARCHITECTURE.volumeMap, EXAMPLE_ARCHITECTURE.beatBoard.beats);
  assert.ok(result["volume-01.md"]);
  assert.ok(result["volume-01.md"].includes("ch1"));
});

test("N7：dry-run 不落盘，返回文件清单", () => {
  const root = mkdtempSync(join(tmpdir(), "n7-dry-"));
  const result = buildWorkspace(inputs(), { dryRun: true, workspaceRoot: root });
  assert.equal(result.skipped, false);
  assert.ok(result.filesWritten.length > 0);
  assert.ok(!existsSync(join(result.workspaceDir, "inkos.json")));
  rmSync(root, { recursive: true, force: true });
});

test("N7：真实写入落盘到书目录，且可幂等跳过", () => {
  // 用临时目录作为 N7 根，避免污染项目 artifacts
  const root = mkdtempSync(join(tmpdir(), "n7-write-"));
  const result = buildWorkspace(inputs(), { dryRun: false, workspaceRoot: root });
  assert.equal(result.skipped, false);
  assert.ok(existsSync(join(result.workspaceDir, "inkos.json")));
  // 二次运行：目录已存在 → 跳过
  const again = buildWorkspace(inputs(), { dryRun: false, workspaceRoot: root });
  assert.equal(again.skipped, true);
  rmSync(root, { recursive: true, force: true });
});

test("N7：force 重建会覆盖已存在的书目录", () => {
  const root = mkdtempSync(join(tmpdir(), "n7-force-"));
  const result = buildWorkspace(inputs(), { dryRun: false, workspaceRoot: root });
  assert.equal(result.skipped, false);
  const forced = buildWorkspace(inputs(), { dryRun: false, force: true, workspaceRoot: root });
  assert.equal(forced.skipped, false);
  assert.equal(forced.filesWritten.length, result.filesWritten.length);
  rmSync(root, { recursive: true, force: true });
});

test("N7：hooksToMd 表格含 beatTag 列（与节拍板对账信息可追溯）", () => {
  const md = hooksToMd(EXAMPLE_STATE0.hookSeeds);
  assert.ok(md.includes("beatTag"));
  assert.ok(md.includes("ch2-h1"));
});
