import type { CharacterAgentOptions,CharacterInfos } from "./types";
import { DEFAULT_BRANCH_ID } from "./types.js";
import { getCharacterInfos } from "./utils";

export interface SystemPromptProvider {
  build(): string
}

export class CharacterSystemPrompt implements SystemPromptProvider {
  private readonly option: CharacterAgentOptions

  public constructor( options:CharacterAgentOptions) {
    this.option = {
          ...options,
          branchId: options.branchId ?? DEFAULT_BRANCH_ID,
        };
  }

  public  build(): string {
    const characterInfos = this.option.characterInfos ?? getCharacterInfos(
        this.option.novelId,
        this.option.branchId!,
        this.option.characterId,
      )
    const systemPrompt = `你是一个角色扮演 Agent。以下是你的角色信息${characterInfos}`
    return systemPrompt;
  }
}

