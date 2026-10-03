import { ChatOpenAI } from "@langchain/openai";
import { EvaluatorAgent } from "@fly-novel/agents";
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
  const agent = new EvaluatorAgent({ model });
  const result = await agent.invoke([
    "评估范围：只检查下列正文中的事实依据与人物行为连续性。",
    "正文版本：draft-1",
    "正文：天色已晚，林舟把船票递给苏晴。苏晴没有接，只看着渐渐靠岸的渡船。",
    "请指出可定位的问题、依据和影响；无法判断的内容标明依据不足。给出修订方向，不要改写正文。",
  ].join("\n"));
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "评估 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
