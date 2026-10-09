import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BookConfig } from "../../novel-flow/book-config";
import type { BookRules, StoryBible } from "../../novel-flow/architect/types";
import type { StoryArchitecture } from "../../novel-flow/architecture/types";
import type { LongTermControls } from "../../novel-flow/controls/types";
import type { CreativeDraft } from "../../novel-flow/draft/types";
import type { State0 } from "../../novel-flow/state0/types";

/** 时间戳文件名片段：YYYYMMDD-HHmmss。 */
export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 小说 ID 只能作为一个目录名；节点名由工作流代码固定。 */
export function novelArtifactDirectory(rootPath: string, novelId: string, nodeName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(novelId)) {
    throw new Error(`无效的 novel_id：${novelId}`);
  }
  return join(resolve(rootPath), novelId, nodeName);
}

/** 将产物根目录绑定到小说级节点产物的读写函数。旧版全局目录不参与查找。 */
export function createNovelArtifacts(rootPath: string) {
  const directoryFor = (novelId: string, nodeName: string) =>
    novelArtifactDirectory(rootPath, novelId, nodeName);

  const latestPath = (novelId: string, nodeName: string, prefix: string, extension: string): string | null => {
    const directory = directoryFor(novelId, nodeName);
    if (!existsSync(directory)) return null;
    const latest = readdirSync(directory, { encoding: "utf8" })
      .filter((name) => name.startsWith(prefix) && name.endsWith(extension))
      .sort()
      .at(-1);
    return latest === undefined ? null : join(directory, latest);
  };

  const saveText = (novelId: string, nodeName: string, prefix: string, extension: string, content: string): string => {
    const directory = directoryFor(novelId, nodeName);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${prefix}${timestamp()}${extension}`);
    writeFileSync(path, content, "utf8");
    console.log(`已保存 ${nodeName} 产物到：${path}`);
    return path;
  };

  const saveJson = (novelId: string, nodeName: string, prefix: string, value: unknown): string =>
    saveText(novelId, nodeName, prefix, ".json", JSON.stringify(value, null, 2));

  const readJson = <T>(novelId: string, nodeName: string, prefix: string): T | null => {
    const path = latestPath(novelId, nodeName, prefix, ".json");
    return path === null ? null : JSON.parse(readFileSync(path, "utf8")) as T;
  };

  return {
    /** 返回指定小说的最新整理输入文件路径及内容。 */
    latestRawInputArtifact(novelId: string): { existing: string; content: string } | null {
      const existing = latestPath(novelId, "normalized_input", "normalized-input-", ".md");
      return existing === null ? null : { existing, content: readFileSync(existing, "utf8") };
    },
    saveRawInput(normalizedInput: string, novelId: string): string {
      return saveText(novelId, "normalized_input", "normalized-input-", ".md", normalizedInput);
    },
    saveDraft(draft: CreativeDraft, novelId: string): string {
      return saveJson(novelId, "draft_node", "draft-", draft);
    },
    readLatestDraft(novelId: string): CreativeDraft | null {
      return readJson<CreativeDraft>(novelId, "draft_node", "draft-");
    },
    saveBookConfig(config: BookConfig, novelId: string): string {
      return saveJson(novelId, "book_config", "book-config-", config);
    },
    readLatestBookConfig(novelId: string): BookConfig | null {
      return readJson<BookConfig>(novelId, "book_config", "book-config-");
    },
    saveStoryBible(bible: StoryBible, novelId: string): string {
      return saveJson(novelId, "story_foundation", "story-bible-", bible);
    },
    readLatestStoryBible(novelId: string): StoryBible | null {
      return readJson<StoryBible>(novelId, "story_foundation", "story-bible-");
    },
    saveBookRulesDoc(rules: BookRules, novelId: string): string {
      return saveJson(novelId, "story_foundation", "book-rules-", rules);
    },
    readLatestBookRules(novelId: string): BookRules | null {
      return readJson<BookRules>(novelId, "story_foundation", "book-rules-");
    },
    saveControls(controls: LongTermControls, novelId: string): string {
      return saveJson(novelId, "controls_node", "controls-", controls);
    },
    readLatestControls(novelId: string): LongTermControls | null {
      return readJson<LongTermControls>(novelId, "controls_node", "controls-");
    },
    saveArchitecture(architecture: StoryArchitecture, novelId: string): string {
      return saveJson(novelId, "architecture_node", "architecture-", architecture);
    },
    readLatestArchitecture(novelId: string): StoryArchitecture | null {
      return readJson<StoryArchitecture>(novelId, "architecture_node", "architecture-");
    },
    saveState0(state0: State0, novelId: string): string {
      return saveJson(novelId, "state0_node", "state0-", state0);
    },
    readLatestState0(novelId: string): State0 | null {
      return readJson<State0>(novelId, "state0_node", "state0-");
    },
    workspaceRoot(novelId: string): string {
      return directoryFor(novelId, "workspace_node");
    },
    saveReady(ready: unknown, novelId: string): string {
      return saveJson(novelId, "ready_node", "ready-", ready);
    },
  };
}

export type NovelArtifacts = ReturnType<typeof createNovelArtifacts>;
