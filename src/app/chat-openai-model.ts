import { ChatOpenAI } from "@langchain/openai";
import { decryptSecret } from "../config/credentials";
import { readEncryptionKey, readSettings } from "../config/settings";

interface ModelSettings {
  readonly baseURL: string;
  readonly model: string;
  readonly credentialRef: string;
}

export interface ConfiguredChatOpenAIOptions {
  readonly timeoutMs?: number;
  readonly disableThinking?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requireModelSettings(value: unknown, provider: string): ModelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`settings.json 的 ${provider} 配置必须是对象`);
  }
  const { baseURL, model, credentialRef } = value as Record<string, unknown>;
  if (!isNonEmptyString(baseURL)) {
    throw new Error(`settings.json 的 ${provider}.baseURL 必须是非空字符串`);
  }
  if (!isNonEmptyString(model)) {
    throw new Error(`settings.json 的 ${provider}.model 必须是非空字符串`);
  }
  if (!isNonEmptyString(credentialRef)) {
    throw new Error(`settings.json 的 ${provider}.credentialRef 必须是非空字符串`);
  }
  return { baseURL, model, credentialRef };
}

/** 从本机加密配置创建 OpenAI 兼容的 LangChain 模型。 */
export async function createConfiguredChatOpenAI(
  provider: string,
  options: ConfiguredChatOpenAIOptions = {},
): Promise<ChatOpenAI> {
  const { settings, credentials } = await readSettings();
  const modelSettings = requireModelSettings(settings[provider], provider);
  const encryptedCredential = credentials[modelSettings.credentialRef];
  if (encryptedCredential === undefined) {
    throw new Error(`找不到 ${provider}.credentialRef 指向的凭据：${modelSettings.credentialRef}`);
  }

  return new ChatOpenAI({
    model: modelSettings.model,
    apiKey: decryptSecret(encryptedCredential, await readEncryptionKey()),
    configuration: { baseURL: modelSettings.baseURL },
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.disableThinking === true
      ? { modelKwargs: { thinking: { type: "disabled" } } }
      : {}),
  });
}
