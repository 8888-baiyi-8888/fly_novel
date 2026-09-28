import { ChatOpenAI } from "@langchain/openai";
import { CharacterAgent } from "@fly-novel/agents";
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
    throw new Error("settings.json 的 deepseek 配置必须是对象");
  }
  const { baseURL, model, credentialRef } = value as Record<string, unknown>;
  if (!isNonEmptyString(baseURL)) {
    throw new Error("settings.json 的 deepseek.baseURL 必须是非空字符串");
  }
  if (!isNonEmptyString(model)) {
    throw new Error("settings.json 的 deepseek.model 必须是非空字符串");
  }
  if (!isNonEmptyString(credentialRef)) {
    throw new Error("settings.json 的 deepseek.credentialRef 必须是非空字符串");
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

  const model = new ChatOpenAI({
    model: deepseek.model,
    apiKey: decryptSecret(encryptedCredential, await readEncryptionKey()),
    configuration: { baseURL: deepseek.baseURL },
    modelKwargs: { thinking: { type: "disabled" } },
  });
  const agent = new CharacterAgent({
    model,
    novelId: "debug-novel",
    branchId: "main",
    characterId: "debug-character",
  });
  const result = await agent.invoke(
    "场景：雨后的渡口。苏晴问你：明天还会回来吗？请以林舟的身份自然回应，并通过动作体现他的情绪。",
  );
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "角色 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
