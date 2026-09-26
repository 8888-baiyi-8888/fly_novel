import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: WorkspaceCheck[];
}

/** 读取并解析 inkos.json；失败返回 null。 */
function readInkos(workspaceDir: string): Record<string, unknown> | null {
  const p = join(workspaceDir, "inkos.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * N8 验收：书目录八类内容物是否齐全、JSON 是否可解析、节拍板章数是否等于 targetChapters。
 * 八类 = BookConfig / 故事圣经+规则 / 角色卡 / 故事走向 / 作者想写 / 不能乱写 / State₀ / 工作空间骨架。
 */
export function verifyWorkspace(workspaceDir: string): VerifyResult {
  const checks: WorkspaceCheck[] = [];
  const has = (p: string) => existsSync(join(workspaceDir, p));

  // ① BookConfig（这本书是什么）
  const inkos = readInkos(workspaceDir);
  if (inkos === null) {
    checks.push({ name: "inkos.json（BookConfig+节奏尺子）", ok: false, detail: "缺失或 JSON 解析失败" });
  } else {
    const bc = (inkos.bookConfig ?? {}) as Record<string, unknown>;
    const detail = [bc.title, bc.platform, `${bc.targetChapters} 章`, `尺子 ${(inkos.platformProfile as Record<string, unknown>)?.platform ?? "?"}`]
      .filter((x) => x !== undefined && x !== null && String(x) !== "")
      .join(" / ");
    checks.push({ name: "inkos.json（BookConfig+节奏尺子）", ok: true, detail });
  }

  // ② 故事圣经 + 书籍规则（这个世界是什么 / 哪些不能乱写）
  checks.push({ name: "story/story_bible.md", ok: has("story/story_bible.md"), detail: has("story/story_bible.md") ? "存在" : "缺失" });
  checks.push({ name: "story/book_rules.md（含 AI 红线）", ok: has("story/book_rules.md"), detail: has("story/book_rules.md") ? "存在" : "缺失" });

  // ③ 角色卡（有哪些角色）
  checks.push({ name: "story/characters.md", ok: has("story/characters.md"), detail: has("story/characters.md") ? "存在" : "缺失" });

  // ④ 故事走向（框架/分卷/叙事线/节拍板）
  checks.push({ name: "story/story_frame.md", ok: has("story/story_frame.md"), detail: has("story/story_frame.md") ? "存在" : "缺失" });
  checks.push({ name: "story/volume_map.md", ok: has("story/volume_map.md"), detail: has("story/volume_map.md") ? "存在" : "缺失" });
  checks.push({ name: "story/threads.md + state/threads.json", ok: has("story/threads.md") && has("state/threads.json"), detail: "逻辑层+调度层" });

  // 节拍板：机器读权威 + 章数 = targetChapters
  const beatsPath = "story/beats/beats.json";
  if (!has(beatsPath)) {
    checks.push({ name: "story/beats/beats.json（节拍板）", ok: false, detail: "缺失" });
  } else {
    try {
      const beats = JSON.parse(readFileSync(join(workspaceDir, beatsPath), "utf8")) as { beats?: unknown[] };
      const chapterCount = beats.beats?.length ?? -1;
      const target = (inkos?.bookConfig as Record<string, unknown>)?.targetChapters as number | undefined;
      const ok = target !== undefined && chapterCount === target;
      checks.push({ name: "story/beats/beats.json（节拍板）", ok, detail: ok ? `${chapterCount} 章 = targetChapters ${target}` : `章数 ${chapterCount} ≠ targetChapters ${target ?? "?"}` });
    } catch {
      checks.push({ name: "story/beats/beats.json（节拍板）", ok: false, detail: "JSON 解析失败" });
    }
  }

  // ⑤ 作者真正想写什么（四件套）
  checks.push({ name: "story/author_intent.md", ok: has("story/author_intent.md"), detail: has("story/author_intent.md") ? "存在" : "缺失" });
  checks.push({ name: "story/current_focus.md", ok: has("story/current_focus.md"), detail: has("story/current_focus.md") ? "存在" : "缺失" });
  checks.push({ name: "story/volume_direction.md", ok: has("story/volume_direction.md"), detail: has("story/volume_direction.md") ? "存在" : "缺失" });
  checks.push({ name: "story/constraints.md", ok: has("story/constraints.md"), detail: has("story/constraints.md") ? "存在" : "缺失" });

  // ⑦ State₀（开始时世界是什么状态）
  checks.push({ name: "state/hooks.json + story/hooks.md（伏笔账本）", ok: has("state/hooks.json") && has("story/hooks.md"), detail: "机器权威+人读投影" });
  checks.push({ name: "state/facts.json（事实库）", ok: has("state/facts.json"), detail: has("state/facts.json") ? "存在" : "缺失" });

  // ⑧ 工作空间骨架（历史信息存哪里）
  checks.push({ name: "chapters/（正文存放）", ok: has("chapters"), detail: has("chapters") ? "存在" : "缺失" });
  checks.push({ name: "story/runtime/（运行痕迹）", ok: has("story/runtime"), detail: has("story/runtime") ? "存在" : "缺失" });
  checks.push({ name: "export/（成品导出）", ok: has("export"), detail: has("export") ? "存在" : "缺失" });

  return { ok: checks.every((c) => c.ok), checks };
}

/** 供测试使用：书目录是否为非空目录。 */
export function isWorkspaceDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
