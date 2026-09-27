import { ChatOpenAI } from "@langchain/openai";
import { WriterAgent } from "@fly-novel/agents";
import { decryptSecret } from "../config/credentials";
import { readEncryptionKey, readSettings } from "../config/settings";

interface ModelSettings {
  readonly baseURL: string;
  readonly model: string;
  readonly credentialRef: string;
}

function requireModelSettings(value: unknown, provider: string): ModelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`settings.json 的 ${provider} 配置必须是对象`);
  const { baseURL, model, credentialRef } = value as Record<string, unknown>;
  if (typeof baseURL !== "string" || baseURL.trim() === "") throw new Error(`settings.json 的 ${provider}.baseURL 必须是非空字符串`);
  if (typeof model !== "string" || model.trim() === "") throw new Error(`settings.json 的 ${provider}.model 必须是非空字符串`);
  if (typeof credentialRef !== "string" || credentialRef.trim() === "") throw new Error(`settings.json 的 ${provider}.credentialRef 必须是非空字符串`);
  return { baseURL, model, credentialRef };
}

async function main(): Promise<void> {
  const provider = process.argv[2] ?? "deepseek";
  const { settings, credentials } = await readSettings();
  const modelSettings = requireModelSettings(settings[provider], provider);
  const encryptedApiKey = credentials[modelSettings.credentialRef];
  if (encryptedApiKey === undefined) throw new Error(`找不到 ${provider}.credentialRef 指向的凭据：${modelSettings.credentialRef}`);

  const model = new ChatOpenAI({
    model: modelSettings.model,
    apiKey: decryptSecret(encryptedApiKey, await readEncryptionKey()),
    configuration: { baseURL: modelSettings.baseURL },
  });
  const agent = new WriterAgent({ model });
  const result = await agent.invoke([
    "任务：写一段雨后渡口的小说正文。",
    "已确认事实：林舟和苏晴在渡口相遇；渡船即将离岸。",
    "要求：第三人称限知视角，语言克制；不要替角色决定是否同行。",
  ].join("\n"));
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "写作 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
