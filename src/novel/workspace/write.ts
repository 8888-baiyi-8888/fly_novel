import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { N7_WORKSPACE_DIR } from "../../config/paths";
import { WorkspaceInputs, WorkspaceFile, BuildWorkspaceResult } from "./types";
import {
  bookRulesToMd,
  storyBibleToMd,
  charactersToMd,
  hooksToMd,
  threadsToMd,
  beatsByVolumeToMd,
} from "./markdown";

/** 平台节奏参数（文档 §13.1 定义；N7 固化进 inkos.json，N9/N10 的节奏尺子）。 */
export interface PlatformProfile {
  platform: string;
  hook: {
    densityPerChapter: [number, number];
    maxActive: number;
    timingMix: Record<string, number>;
  };
  pacing: { consecutiveLowPressureMax: number; climaxMultiple: number };
  chapterEndHook: { required: boolean };
  payoffSpacing: { minor: number; medium: number; major: number };
  coreHookMax: number;
}

/**
 * 按平台选择节奏尺子：文档 §13.1 只有番茄一套，这里补充晋江套（慢热向）。
 * - 番茄（免费阅读/日更）：节奏快、近程钩子多、爽点密（5/15/30）。
 * - 晋江（付费订阅/慢热）：单章伏笔更疏、慢燃占比高、允许连续铺垫章、爽点更缓（8/20/40）。
 * 数值为按平台特性设定的默认值，后续可按具体书微调。
 */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  fanqie: {
    platform: "fanqie",
    hook: {
      densityPerChapter: [0.2, 0.35],
      maxActive: 12,
      timingMix: { immediate: 0.1, "near-term": 0.3, "mid-arc": 0.35, "slow-burn": 0.2, endgame: 0.05 },
    },
    pacing: { consecutiveLowPressureMax: 2, climaxMultiple: 5 },
    chapterEndHook: { required: true },
    payoffSpacing: { minor: 5, medium: 15, major: 30 },
    coreHookMax: 3,
  },
  jinjiang: {
    platform: "jinjiang",
    hook: {
      densityPerChapter: [0.15, 0.3],
      maxActive: 10,
      timingMix: { immediate: 0.05, "near-term": 0.2, "mid-arc": 0.35, "slow-burn": 0.35, endgame: 0.05 },
    },
    pacing: { consecutiveLowPressureMax: 3, climaxMultiple: 4 },
    chapterEndHook: { required: true },
    payoffSpacing: { minor: 8, medium: 20, major: 40 },
    coreHookMax: 4,
  },
};

/** N2 的 platform 是中文（如"晋江"/"番茄"），映射到参数键；未知平台默认番茄。 */
const PLATFORM_KEY: Record<string, string> = { 晋江: "jinjiang", 番茄: "fanqie" };

/** 按书平台选节奏尺子（找不到对应平台时回退番茄）。 */
export function resolvePlatformProfile(platform: string): PlatformProfile {
  return PLATFORM_PROFILES[PLATFORM_KEY[platform] ?? "fanqie"] ?? PLATFORM_PROFILES.fanqie;
}

/** 兼容旧导出（默认番茄套，测试与历史调用不受影响）。 */
export const PLATFORM_PROFILE: PlatformProfile = PLATFORM_PROFILES.fanqie;

/** 把 N6 种子转成机器读的 hook 账本（与 hooks.md 同一数据）。 */
function hooksJson(state0: WorkspaceInputs["state0"]): string {
  return JSON.stringify({ bookId: state0.bookId, hooks: state0.hookSeeds, archive: [] }, null, 2);
}

/** TruthOracle 初始事实（N6 的人物状态/关系状态/世界状态 → 事实条目）。 */
function factsJson(state0: WorkspaceInputs["state0"]): string {
  const facts = [
    ...state0.characterStates.map((c) => ({ subject: c.name, predicate: "位置/身份/情绪/认知/资源", value: `${c.location}｜${c.identity}｜${c.emotion}｜${c.cognition}｜${c.resources}` })),
    ...state0.relationshipStates.map((r) => ({ subject: r.subjects.join("+"), predicate: "关系/信任/知情", value: `${r.relation}｜${r.trust}｜${r.knowledge}` })),
    ...state0.worldState.map((w) => ({ subject: "世界", predicate: w.key, value: w.value })),
  ];
  return JSON.stringify({ bookId: state0.bookId, facts }, null, 2);
}

/** 生成全部待写文件（dry-run 也走这里，只生成不落盘）。 */
export function buildWorkspaceFiles(inputs: WorkspaceInputs): WorkspaceFile[] {
  const { draft, bookConfig, storyBible, bookRules, controls, architecture, state0 } = inputs;
  const volumeBeats = beatsByVolumeToMd(architecture.volumeMap, architecture.beatBoard.beats);

  const files: WorkspaceFile[] = [
    // 书配置 + 平台节奏尺子
    {
      relPath: "inkos.json",
      content: JSON.stringify(
        {
          bookId: bookConfig.bookId,
          title: bookConfig.title,
          bookConfig,
          platformProfile: resolvePlatformProfile(bookConfig.platform),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    },
    // 创作控制四件套（作者想怎么写）
    { relPath: "story/author_intent.md", content: `# 作者意图\n\n${controls.authorIntent}\n` },
    {
      relPath: "story/current_focus.md",
      content: `# 当前重点（随进度滚动更新）\n\n${controls.currentFocus.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n`,
    },
    {
      relPath: "story/volume_direction.md",
      content: `# 分卷方向\n\n${controls.volumeDirections.map((v) => `## ${v.volume}\n\n${v.direction}\n`).join("\n")}\n`,
    },
    {
      relPath: "story/constraints.md",
      content: `# 创作约束（不能怎么写）\n\n${controls.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`,
    },
    // 世界与规则
    { relPath: "story/story_bible.md", content: storyBibleToMd(storyBible) },
    { relPath: "story/book_rules.md", content: bookRulesToMd(bookRules) },
    {
      relPath: "story/story_frame.md",
      content: `# 故事框架\n\n- 核心故事：${architecture.storyFrame.coreStory}\n- 核心冲突：${architecture.storyFrame.coreConflict}\n- 主角路径：${architecture.storyFrame.protagonistPath.join(" → ")}\n`,
    },
    {
      relPath: "story/volume_map.md",
      content: `# 分卷规划\n\n${architecture.volumeMap
        .map((v) => `## ${v.volume} ${v.title}\n\n- 目标：${v.goal}\n- 阶段：${v.stages.join(" → ")}\n`)
        .join("\n")}\n`,
    },
    { relPath: "story/characters.md", content: charactersToMd(architecture.characterCards) },
    // 伏笔账本（人读 + 归档）
    { relPath: "story/hooks.md", content: hooksToMd(state0.hookSeeds) },
    { relPath: "story/hooks_archive.md", content: "# 已回收伏笔归档\n\n（初始为空，还清的伏笔由 Settler 挪到这里）\n" },
    // 叙事线
    { relPath: "story/threads.md", content: threadsToMd(architecture.threadMap.lines, state0.threadBoard) },
    // 节拍板：机器读权威 + 按卷人读投影
    { relPath: "story/beats/beats.json", content: JSON.stringify(architecture.beatBoard, null, 2) },
    ...Object.entries(volumeBeats).map(([name, content]) => ({ relPath: `story/beats/${name}`, content })),
    // 机器读权威状态（与 story/*.md 同一数据的 JSON 投影）
    { relPath: "state/hooks.json", content: hooksJson(state0) },
    { relPath: "state/threads.json", content: JSON.stringify({ bookId: state0.bookId, threadBoard: state0.threadBoard }, null, 2) },
    { relPath: "state/facts.json", content: factsJson(state0) },
  ];
  return files;
}

/** 目录骨架（初始为空，N9 开始填充）。 */
const EMPTY_DIRS = ["chapters", "story/runtime", "export"];

export interface BuildWorkspaceOptions {
  /** 书目录已存在时是否强制重建（默认 false：跳过，保护人可读可手改的权威文件）。 */
  force?: boolean;
  /** true 时不落盘，只生成内容并返回（memory 演示用）。 */
  dryRun?: boolean;
  /** 工作空间根目录（默认 artifacts/n7-workspace；测试可注入临时目录）。 */
  workspaceRoot?: string;
}

/** N7 主入口：N1~N6 产物 → 书项目目录。 */
export function buildWorkspace(inputs: WorkspaceInputs, options: BuildWorkspaceOptions = {}): BuildWorkspaceResult {
  const bookId = inputs.bookConfig.bookId;
  const workspaceDir = join(options.workspaceRoot ?? N7_WORKSPACE_DIR, bookId);

  if (existsSync(workspaceDir) && options.force !== true) {
    return { bookId, workspaceDir, skipped: true, filesWritten: [] };
  }

  const files = buildWorkspaceFiles(inputs);
  if (options.dryRun === true) {
    return { bookId, workspaceDir, skipped: false, filesWritten: files.map((f) => f.relPath) };
  }

  mkdirSync(workspaceDir, { recursive: true });
  for (const dir of EMPTY_DIRS) {
    mkdirSync(join(workspaceDir, dir), { recursive: true });
  }
  for (const file of files) {
    const fullPath = join(workspaceDir, file.relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
  }
  return { bookId, workspaceDir, skipped: false, filesWritten: files.map((f) => f.relPath) };
}
