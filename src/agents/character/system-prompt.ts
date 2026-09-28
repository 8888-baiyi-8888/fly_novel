import type { CharacterAgentOptions,CharacterInfos } from "./types";
import { DEFAULT_BRANCH_ID } from "./types.js";
import { getCharacterInfos } from "./utils";
import { resolveCharacterAgentOptions } from "./utils.js";

export interface SystemPromptProvider {
  build(): string
}

export class CharacterSystemPrompt implements SystemPromptProvider {
  private readonly options: CharacterAgentOptions

  public constructor( options:CharacterAgentOptions) {
    this.options = resolveCharacterAgentOptions(options)
  }

  public  build(): string {
    const characterInfos = this.options.characterInfos ?? getCharacterInfos(
        this.options.novelId,
        this.options.branchId!,
        this.options.characterId,
        this.options.basePath!
      )
    const systemPrompt = `你是一个角色扮演 Agent。以下是你的角色信息${characterInfos}`
    return systemPrompt;
  }
}

