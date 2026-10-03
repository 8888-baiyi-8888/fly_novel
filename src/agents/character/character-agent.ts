import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { CharacterSystemPrompt} from "./system-prompt.js";
import type { CharacterAgentOptions } from "./types.js";
import { DEFAULT_BRANCH_ID } from "./types.js";
import { resolveCharacterAgentOptions } from "./utils.js";
import { CharacterSession } from "./session.js";

/** 角色 Agent */
export class CharacterAgent extends BaseAgent {
  private readonly agent;
  private readonly options:CharacterAgentOptions;

  public constructor(options: CharacterAgentOptions) {
    super();
    this.options = resolveCharacterAgentOptions(options)
    const systemPrompt = new CharacterSystemPrompt(this.options).build();
    const checkpointer = new CharacterSession(this.options).get()
    this.agent = createDeepAgent({
      model: this.options.model,
      systemPrompt,
      checkpointer:checkpointer
    });
  }

  public async invoke(content: string) {
    const thread_id = `${this.options.novelId}_${this.options.branchId}_${this.options.characterId}`
    return this.agent.invoke(
      {
        messages: [{ role: "user", content }]
      },
      {
        configurable:{thread_id:thread_id}
      }
    )
  }
}
