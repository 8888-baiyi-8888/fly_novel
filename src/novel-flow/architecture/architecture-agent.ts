import { CreativeDraft } from "../draft/types";
import { slugifyTitle } from "../book-config/book-config";
import { StoryArchitectAgent, ArchitectureInput } from "./story-architect-agent";
import { DirectorAgent } from "./director-agent";
import { StoryArchitecture } from "./types";

/**
 * N5 编排 Agent：架构师（前四件）→ Director（节拍板）串行。
 * 节拍板输入依赖前四件（文档：节拍板输入 = 前四件 + 创作简报），因此必须串行。
 */
export class ArchitectureAgent {
  constructor(
    private readonly architect: StoryArchitectAgent,
    private readonly director: DirectorAgent,
  ) {}

  /** 生成 N5 五件套（bookId 从书名确定性生成，与 N2/N3/N4 一致）。 */
  async createArchitecture(input: ArchitectureInput): Promise<StoryArchitecture> {
    const parts = await this.architect.createParts(input);
    const beatBoard = await this.director.createBeatBoard(input.draft, parts);
    return {
      bookId: slugifyTitle(input.draft.title),
      title: input.draft.title,
      storyFrame: parts.storyFrame,
      volumeMap: parts.volumeMap,
      characterCards: parts.characterCards,
      threadMap: parts.threadMap,
      beatBoard,
    };
  }
}
