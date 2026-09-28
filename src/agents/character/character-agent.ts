import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { CharacterSystemPrompt} from "./system-prompt.js";
import type { CharacterAgentOptions } from "./types.js";



/** 角色 Agent */
export class CharacterAgent extends BaseAgent {
  private readonly agent;

  public constructor(options: CharacterAgentOptions) {
    super();
    const systemPrompt = new CharacterSystemPrompt(options).build();

    this.agent = createDeepAgent({
      model: options.model,
      systemPrompt,
    });
  }

  public async invoke(content: string) {
    return this.agent.invoke({
      messages: [
        {
          role: "user",
          content,
        },
      ],
    });
  }
}
