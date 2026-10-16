import { BaseAgent } from "../core/base-agent.js";
import { CharacterSystemPrompt } from "./system-prompt.js";
import type { CharacterAgentOptions } from "./types.js";
import { DEFAULT_BRANCH_ID } from "./types.js";
import { resolveCharacterAgentOptions } from "./utils.js";
import { CharacterSession } from "./session.js";

/** 角色 Agent */
export class CharacterAgent extends BaseAgent {
  private readonly options: CharacterAgentOptions;

  public constructor(options: CharacterAgentOptions) {
    const resolvedOptions = resolveCharacterAgentOptions(options);
    const systemPrompt = new CharacterSystemPrompt(resolvedOptions).build();
    const checkpointer = new CharacterSession(resolvedOptions).get();
    super({
      model: resolvedOptions.model,
      systemPrompt,
      checkpointer,
    });
    this.options = resolvedOptions;
  }

  public async generate(content: string, threadId?: string) {
    const threadIdToUse = threadId ?? `${this.options.novelId}_${this.options.branchId}_${this.options.characterId}`;
    return this.invoke(content, { configurable: { thread_id: threadIdToUse } });
  }
}
