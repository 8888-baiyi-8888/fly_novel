import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { CharacterAgent, configureAgentRuntime } from "@fly-novel/agents";
import { decryptSecret } from "../config/credentials";
import { APP_HOME } from "../config/paths";
import { readEncryptionKey, readSettings } from "../config/settings";
import { join } from "node:path";

interface DeepSeekSettings {
  readonly baseURL: string;
  readonly model: string;
  readonly credentialRef: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requireDeepSeekSettings(value: unknown): DeepSeekSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings.json 的 deepseek 配置必须是对象。");
  }
  const { baseURL, model, credentialRef } = value as Record<string, unknown>;
  if (!isNonEmptyString(baseURL)) {
    throw new Error("settings.json 的 deepseek.baseURL 必须是非空字符串。");
  }
  if (!isNonEmptyString(model)) {
    throw new Error("settings.json 的 deepseek.model 必须是非空字符串。");
  }
  if (!isNonEmptyString(credentialRef)) {
    throw new Error("settings.json 的 deepseek.credentialRef 必须是非空字符串。");
  }
  return { baseURL, model, credentialRef };
}

async function main(): Promise<void> {
  const { settings, credentials } = await readSettings();
  const deepseek = requireDeepSeekSettings(settings.deepseek);
  const encryptedCredential = credentials[deepseek.credentialRef];
  if (encryptedCredential === undefined) {
    throw new Error(`找不到 deepseek.credentialRef 指向的凭据：${deepseek.credentialRef}`);
  }
  const apiKey = decryptSecret(encryptedCredential, await readEncryptionKey());
  const model = new ChatOpenAI({
    model: deepseek.model,
    apiKey,
    configuration: { baseURL: deepseek.baseURL },
  });
  configureAgentRuntime({
    characterMemoryDirectory: join(APP_HOME, "memories", "characters"),
    resolveModel(modelId) {
      if (modelId !== undefined && modelId !== "deepseek") {
        throw new Error(`样例只注册 deepseek 模型，不能解析：${modelId}`);
      }
      return model;
    },
  });

  const agent = new CharacterAgent({
    modelId: "deepseek",
    storyId: "debug-story",
    branchId: "main",
    characterId: "debug-character",
  });
  const result = await agent.run({
    scene: {
      location: "雨后的渡口",
      visibleEvents: ["苏晴问林舟：明天还会回来吗？"],
    },
    responseFormat: z.strictObject({
      dialogue: z.string().describe("角色实际说出的台词"),
      action: z.string().describe("角色实际做出的动作"),
    }),
  });
  console.dir(result.structuredResponse, { depth: null });

  // 复用同一实例；框架自动带入上一轮历史，无需传回 result。
  const nextResult = await agent.run({
    scene: {
      location: "雨后的渡口",
      visibleEvents: ["苏晴追问：你刚才是怎么回答我的？"],
    },
    responseFormat: z.strictObject({
      reply: z.string().describe("角色对追问的回应"),
    }),
  });
  console.dir(nextResult.structuredResponse, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "角色 Agent 样例运行失败。");
    process.exitCode = 1;
  });
}
