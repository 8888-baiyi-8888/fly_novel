import { ChatOpenAI } from "@langchain/openai";
import { DirectorAgent } from "@fly-novel/agents";
import { decryptSecret } from "../config/credentials";
import { readEncryptionKey, readSettings } from "../config/settings";

interface ModelSettings {
  readonly baseURL: string;
  readonly model: string;
  readonly credentialRef: string;
}

function requireModelSettings(value: unknown, provider: string): ModelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`settings.json 的 ${provider} 配置必须是对象`);
  }
  const { baseURL, model, credentialRef } = value as Record<string, unknown>;
  if (typeof baseURL !== "string" || baseURL.trim() === "") {
    throw new Error(`settings.json 的 ${provider}.baseURL 必须是非空字符串`);
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error(`settings.json 的 ${provider}.model 必须是非空字符串`);
  }
  if (typeof credentialRef !== "string" || credentialRef.trim() === "") {
    throw new Error(`settings.json 的 ${provider}.credentialRef 必须是非空字符串`);
  }
  return { baseURL, model, credentialRef };
}

async function main(): Promise<void> {
  const provider = process.argv[2] ?? "deepseek";
  const { settings, credentials } = await readSettings();
  const modelSettings = requireModelSettings(settings[provider], provider);
  const encryptedApiKey = credentials[modelSettings.credentialRef];
  if (encryptedApiKey === undefined) {
    throw new Error(`找不到 ${provider}.credentialRef 指向的凭据：${modelSettings.credentialRef}`);
  }

  const model = new ChatOpenAI({
    model: modelSettings.model,
    apiKey: decryptSecret(encryptedApiKey, await readEncryptionKey()),
    configuration: { baseURL: modelSettings.baseURL },
  });
  const agent = new DirectorAgent({ model });
  const result = await agent.invoke("请为林舟和苏晴设计一个发生在雨后渡口的场景，保留双方自主选择的空间。");
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "导演 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
