import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { createMiddleware } from "langchain";
import { z, type ZodType } from "zod";
import { systemPrompt } from "./system-prompt.js";

export interface DirectorAgentOptions {
  /** 应用创建的模型实例；其中包含模型选择与 API 凭据配置。 */
  model: BaseLanguageModel;
}

/** 导演 Agent */
export class DirectorAgent extends BaseAgent {
  private readonly model: BaseLanguageModel;
  private readonly agent;

  public constructor(options: DirectorAgentOptions) {
    super();
    this.model = options.model;
    this.agent = createDeepAgent({
      model: this.model,
      systemPrompt,
      middleware: [createMiddleware({
        name: "DirectorJsonOutput",
        wrapModelCall: (request, handler) => {
          if (request.runtime.configurable?.directorJsonMode !== true) return handler(request);
          // RunnableInterface 未暴露供应商调用参数；ChatOpenAI.withConfig 支持 response_format。
          const model = request.model as typeof request.model & {
            withConfig(config: { response_format: { type: "json_object" } }): typeof request.model;
          };
          return handler({
            ...request,
            model: model.withConfig({ response_format: { type: "json_object" } }),
            tools: [],
          });
        },
      })],
    });
  }

  public async generate(content: string, options: { readonly responseFormat?: ZodType } = {}) {
    const responseFormat = options.responseFormat;
    const prompt = responseFormat === undefined
      ? content
      : `${content}\n\n请仅输出 JSON，不要添加 Markdown 或说明。输出必须符合以下 JSON Schema：\n${JSON.stringify(z.toJSONSchema(responseFormat))}`;
    const result = await this.agent.invoke(
      { messages: [{ role: "user", content: prompt }] },
      responseFormat === undefined ? undefined : { configurable: { directorJsonMode: true } },
    );
    if (responseFormat === undefined) return result;

    const response = [...result.messages].reverse().find((message) => message.getType() === "ai");
    const responseText = typeof response?.content === "string"
      ? response.content
      : Array.isArray(response?.content)
        ? response.content.flatMap((part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []).join("")
        : "";
    try {
      const value: unknown = JSON.parse(responseText);
      const parsed = responseFormat.safeParse(value);
      return parsed.success
        ? { structuredResponse: parsed.data }
        : { messages: response === undefined ? [] : [response], structuredResponseError: parsed.error.message };
    } catch {
      return { messages: response === undefined ? [] : [response] };
    }
  }
}
