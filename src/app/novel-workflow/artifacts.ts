import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BookConfig } from "../../novel-flow/book-config";
import { BookRules, StoryBible } from "../../novel-flow/architect/types";
import { StoryArchitecture } from "../../novel-flow/architecture/types";
import { LongTermControls } from "../../novel-flow/controls/types";
import { CreativeDraft } from "../../novel-flow/draft/types";
import { State0 } from "../../novel-flow/state0/types";
import {
  N0_RAW_INPUT_DIR,
  N1_DRAFT_DIR,
  N2_BOOK_CONFIG_DIR,
  N3_STORY_BIBLE_DIR,
  N4_CONTROLS_DIR,
  N5_ARCHITECTURE_DIR,
  N6_STATE0_DIR,
} from "../../novel-flow/paths";

/** 时间戳文件名片段：YYYYMMDD-HHmmss。 */
export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function saveRawInput(rawInput: string): string {
  mkdirSync(N0_RAW_INPUT_DIR, { recursive: true });
  const path = join(N0_RAW_INPUT_DIR, `raw-input-${timestamp()}.md`);
  writeFileSync(path, rawInput, "utf8");
  console.log(`\n已保存 N0 原始输入到：${path}`);
  return path;
}

export function saveDraft(draft: CreativeDraft): string {
  mkdirSync(N1_DRAFT_DIR, { recursive: true });
  const path = join(N1_DRAFT_DIR, `draft-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(draft, null, 2), "utf8");
  console.log(`已保存 N1 草案到：${path}`);
  return path;
}

export function saveBookConfig(config: BookConfig): string {
  mkdirSync(N2_BOOK_CONFIG_DIR, { recursive: true });
  const path = join(N2_BOOK_CONFIG_DIR, `book-config-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  console.log(`已保存 N2 书籍配置到：${path}`);
  return path;
}

export function saveStoryBible(bible: StoryBible): string {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const path = join(N3_STORY_BIBLE_DIR, `story-bible-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(bible, null, 2), "utf8");
  console.log(`已保存 N3 故事圣经到：${path}`);
  return path;
}

export function saveBookRulesDoc(rules: BookRules): string {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const path = join(N3_STORY_BIBLE_DIR, `book-rules-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(rules, null, 2), "utf8");
  console.log(`已保存 N3 书籍规则到：${path}`);
  return path;
}

export function saveControls(controls: LongTermControls): string {
  mkdirSync(N4_CONTROLS_DIR, { recursive: true });
  const path = join(N4_CONTROLS_DIR, `controls-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(controls, null, 2), "utf8");
  console.log(`已保存 N4 长期创作控制到：${path}`);
  return path;
}

export function saveArchitecture(architecture: StoryArchitecture): string {
  mkdirSync(N5_ARCHITECTURE_DIR, { recursive: true });
  const path = join(N5_ARCHITECTURE_DIR, `architecture-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(architecture, null, 2), "utf8");
  console.log(`已保存 N5 小说静态架构到：${path}`);
  return path;
}

export function saveState0(state0: State0): string {
  mkdirSync(N6_STATE0_DIR, { recursive: true });
  const path = join(N6_STATE0_DIR, `state0-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(state0, null, 2), "utf8");
  console.log(`已保存 N6 State₀ 到：${path}`);
  return path;
}

export function latestRawInputArtifact(): string | null {
  mkdirSync(N0_RAW_INPUT_DIR, { recursive: true });
  const files = readdirSync(N0_RAW_INPUT_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("raw-input-") && name.endsWith(".md"))
    .sort();
  return files.length === 0 ? null : files[files.length - 1];
}

export function readLatestRawInput(): string | null {
  const file = latestRawInputArtifact();
  return file === null ? null : readFileSync(join(N0_RAW_INPUT_DIR, file), "utf8");
}

export function latestDraftArtifact(): string | null {
  mkdirSync(N1_DRAFT_DIR, { recursive: true });
  const files = readdirSync(N1_DRAFT_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("draft-") && name.endsWith(".json"))
    .sort();
  return files.length === 0 ? null : files[files.length - 1];
}

export function readLatestDraft(): CreativeDraft | null {
  const file = latestDraftArtifact();
  return file === null ? null : JSON.parse(readFileSync(join(N1_DRAFT_DIR, file), "utf8")) as CreativeDraft;
}

function readLatestJson<T>(directory: string, prefix: string): T | null {
  mkdirSync(directory, { recursive: true });
  const files = readdirSync(directory, { encoding: "utf8" })
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  return JSON.parse(readFileSync(join(directory, files[files.length - 1]), "utf8")) as T;
}

export function readLatestBookConfig(): BookConfig | null {
  return readLatestJson<BookConfig>(N2_BOOK_CONFIG_DIR, "book-config-");
}

export function readLatestStoryBible(): StoryBible | null {
  return readLatestJson<StoryBible>(N3_STORY_BIBLE_DIR, "story-bible-");
}

export function readLatestBookRules(): BookRules | null {
  return readLatestJson<BookRules>(N3_STORY_BIBLE_DIR, "book-rules-");
}

export function readLatestControls(): LongTermControls | null {
  return readLatestJson<LongTermControls>(N4_CONTROLS_DIR, "controls-");
}

export function readLatestArchitecture(): StoryArchitecture | null {
  return readLatestJson<StoryArchitecture>(N5_ARCHITECTURE_DIR, "architecture-");
}

export function readLatestState0(): State0 | null {
  return readLatestJson<State0>(N6_STATE0_DIR, "state0-");
}
