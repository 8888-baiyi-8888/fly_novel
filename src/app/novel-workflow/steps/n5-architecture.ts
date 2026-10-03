import { ArchitectureAgent } from "../../../novel-flow/architecture";
import { StoryArchitecture } from "../../../novel-flow/architecture/types";
import { BookRules, StoryBible } from "../../../novel-flow/architect/types";
import { LongTermControls } from "../../../novel-flow/controls/types";
import { CreativeDraft } from "../../../novel-flow/draft/types";
import { readLatestBookRules, readLatestControls, readLatestDraft, readLatestStoryBible, saveArchitecture } from "../artifacts";

export async function runN5Only(
  architecture: ArchitectureAgent,
  persist: boolean,
  input?: { draft: CreativeDraft; storyBible: StoryBible; bookRules: BookRules; controls: LongTermControls },
): Promise<StoryArchitecture> {
  let draft: CreativeDraft;
  let storyBible: StoryBible;
  let bookRules: BookRules;
  let controls: LongTermControls;
  if (input !== undefined) {
    ({ draft, storyBible, bookRules, controls } = input);
  } else {
    const latestDraft = readLatestDraft();
    if (latestDraft === null) {
      throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
    }
    draft = latestDraft;
    const latestBible = readLatestStoryBible();
    if (latestBible === null) {
      throw new Error("没有找到 N3 故事圣经（artifacts/n3-story-bible/），请先运行 --step n3 或全链路");
    }
    storyBible = latestBible;
    const latestRules = readLatestBookRules();
    if (latestRules === null) {
      throw new Error("没有找到 N3 书籍规则（artifacts/n3-story-bible/），请先运行 --step n3 或全链路");
    }
    bookRules = latestRules;
    const latestControls = readLatestControls();
    if (latestControls === null) {
      throw new Error("没有找到 N4 长期创作控制（artifacts/n4-controls/），请先运行 --step n4 或全链路");
    }
    controls = latestControls;
  }
  const result = await architecture.createArchitecture({ draft, storyBible, bookRules, controls });
  console.log(`\n【N5 小说静态架构】五件套：故事框架 / 分卷规划（${result.volumeMap.length} 卷）/ 角色卡（${result.characterCards.length} 张）/ 叙事线地图（${result.threadMap.lines.length} 条线）/ 节拍板（${result.beatBoard.beats.length} 章）`);
  console.log(JSON.stringify(
    {
      bookId: result.bookId,
      title: result.title,
      storyFrame: result.storyFrame,
      volumeMap: result.volumeMap,
      characterCards: result.characterCards,
      threadMap: result.threadMap,
      beatBoardSummary: {
        chapterCount: result.beatBoard.beats.length,
        sample: result.beatBoard.beats.slice(0, 3),
      },
    },
    null,
    2,
  ));
  if (persist) {
    saveArchitecture(result);
  }
  return result;
}

export async function runN5Step(architecture: ArchitectureAgent, persist: boolean): Promise<void> {
  await runN5Only(architecture, persist);
}
