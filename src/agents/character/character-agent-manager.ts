import { CharacterAgent } from "./character-agent";
import type { CharacterAgentOptions, CharacterInfos } from "./types.js";

export interface CharacterAgentGenerateOptions {
  /** 当前角色档案；首次创建该角色 Agent 时写入系统提示词。 */
  readonly characterInfos?: CharacterInfos;
  /** 覆盖默认持久会话 ID；章节级一次性角色调用可使用章节范围 ID。 */
  readonly threadId?: string;
}

const DEFAULT_MAX_AGENTS = 100;

export class CharacterAgentManager {
  private readonly agents = new Map<string, CharacterAgent>();

  public constructor(
    private readonly baseOptions: Omit<
      CharacterAgentOptions,
      "characterId"
    >,
    private readonly maxAgents = DEFAULT_MAX_AGENTS,
  ) {
    if (!Number.isInteger(maxAgents) || maxAgents < 1) {
      throw new RangeError("maxAgents 必须是正整数");
    }
  }

  /** 根据角色 ID 获取或创建 Agent */
  private getAgent(characterId: string, characterInfos?: CharacterInfos): CharacterAgent {
    const existing = this.agents.get(characterId);

    if (existing) {
      this.agents.delete(characterId);
      this.agents.set(characterId, existing);
      return existing;
    }

    if (this.agents.size >= this.maxAgents) {
      const leastRecentlyUsed = this.agents.keys().next().value;
      if (leastRecentlyUsed !== undefined) {
        this.agents.delete(leastRecentlyUsed);
      }
    }

    const agent = new CharacterAgent({
      ...this.baseOptions,
      characterId,
      ...(characterInfos === undefined ? {} : { characterInfos }),
    });

    this.agents.set(characterId, agent);

    return agent;
  }

  /** 清除所有缓存的角色 Agent 实例。 */
  public clear(): void {
    this.agents.clear();
  }

  /** 统一的角色生成接口 */
  public async generate(
    characterId: string,
    content: string,
    options: CharacterAgentGenerateOptions = {},
  ) {
    const agent = this.getAgent(characterId, options.characterInfos);

    return agent.generate(content, options.threadId);
  }
}
