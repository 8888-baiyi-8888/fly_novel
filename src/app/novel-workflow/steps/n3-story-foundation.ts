import { ArchitectAgent, buildCreativeBrief } from "../../../novel-flow/architect";
import { BookRules, StoryBible } from "../../../novel-flow/architect/types";
import { readLatestBookConfig, readLatestDraft, saveBookRulesDoc, saveStoryBible } from "../artifacts";

export async function runN3Only(
  architect: ArchitectAgent,
  persist: boolean,
): Promise<{ storyBible: StoryBible; bookRules: BookRules }> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  const bookConfig = readLatestBookConfig();
  if (bookConfig === null) {
    throw new Error("没有找到 N2 书籍配置（artifacts/n2-book-config/），请先运行 --step n2 或全链路");
  }
  const brief = buildCreativeBrief(draft);
  console.log(`\n【创作简报】\n${brief}\n`);
  const { storyBible, bookRules } = await architect.createStoryFoundation(brief, draft, bookConfig);
  console.log(`\n【N3 故事圣经】共 ${storyBible.sections.length} 节`);
  console.log(JSON.stringify(storyBible, null, 2));
  if (persist) {
    saveStoryBible(storyBible);
  }
  console.log(
    `\n【N3 书籍规则】书特定 ${bookRules.rules.filter((r) => r.category === "story").length} 条 + AI 红线 ${bookRules.rules.filter((r) => r.category === "ai-redline").length} 条`,
  );
  console.log(JSON.stringify(bookRules, null, 2));
  if (persist) {
    saveBookRulesDoc(bookRules);
  }
  return { storyBible, bookRules };
}
