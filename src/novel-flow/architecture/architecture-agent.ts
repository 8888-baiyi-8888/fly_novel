import { CreativeDraft } from "../draft/types";
import { generateNovelId } from "../book-config/book-config";
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

  /** 生成 N5 五件套（使用工作流提供的 novelId；独立调用时按书名生成默认 ID）。 */
  async createArchitecture(input: ArchitectureInput & { novelId?: string }): Promise<StoryArchitecture> {
    const novelId = input.novelId ?? generateNovelId(input.draft.title);
    const parts = await this.architect.createParts({ ...input, novelId });
    const beatBoard = await this.director.createBeatBoard(input.draft, parts);
    return {
      characterSchemaVersion: 1,
      novelId,
      title: input.draft.title,
      storyFrame: parts.storyFrame,
      volumeMap: parts.volumeMap,
      characterCards: parts.characterCards,
      threadMap: parts.threadMap,
      beatBoard,
    };
  }
}
