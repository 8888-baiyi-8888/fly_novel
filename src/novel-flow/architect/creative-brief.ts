import { CreativeDraft } from "../draft/types";

/**
 * 创作简报（Creative Brief）：给架构师的「需求简报」。
 * 文档定义：从创意草案自动提炼（Basics + 冲突 + 作者意图浓缩成 1-2 段）。
 * 程序化生成，不调 LLM；架构师先读简报，需要细节再查草案。
 */
export function buildCreativeBrief(draft: CreativeDraft): string {
  const lines: string[] = [
    `《${draft.title}》——${draft.genre.join("、")}，${draft.platform}，目标 ${draft.targetChapters} 章 / 单章 ${draft.chapterWordCount} 字。`,
  ];
  if (draft.blurb !== undefined && draft.blurb.length > 0) {
    lines.push(`一句话故事：${draft.blurb}`);
  }
  lines.push(`核心卖点：${draft.coreConflict}`);
  if (draft.constraints.length > 0) {
    lines.push(`作者特别在意：${draft.constraints.join("；")}`);
  }
  if (draft.authorIntent.length > 0) {
    lines.push(`作者意图：${draft.authorIntent}`);
  }
  return lines.join("\n");
}
