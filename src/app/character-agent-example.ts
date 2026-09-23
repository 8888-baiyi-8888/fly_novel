import { ChatOpenAI } from "@langchain/openai";
import { CharacterAgent, configureAgentRuntime } from "@fly-novel/agents";
import { decryptSecret } from "../config/credentials";
import { readEncryptionKey, readSettings } from "../config/settings";

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
    outputRequirements: {
      scope: "以林舟身份作出简短回应。",
      maxDialogueLines: 2,
      maxActions: 1,
      includeInnerActivity: true,
    },
  });
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "角色 Agent 样例运行失败。");
    process.exitCode = 1;
  });
}
