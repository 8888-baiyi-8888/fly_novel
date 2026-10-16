import { ChatOpenAI } from "@langchain/openai";
import { AuditAgent, CensorAgent } from "@fly-novel/agents";
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
  const audit = new AuditAgent({ model });
  const censor = new CensorAgent({ model });
  const draft = "天色已晚，林舟把船票递给苏晴。苏晴没有接，只看着渐渐靠岸的渡船。";
  const auditResult = await audit.generate(JSON.stringify({
    draft,
    dispatch: { castPlan: [{ name: "林舟", hardLimits: ["不得透露船票来源"] }], hookDirectives: { resolve: ["渡船秘密"] } },
    scenesheet: { scenes: [{ purpose: "苏晴拒绝船票" }] },
    simulations: [{ character: "苏晴", actions: ["没有接船票"] }],
    facts: ["渡船已于傍晚靠岸"],
  }));
  const censorResult = await censor.generate(JSON.stringify({ draft, contentPolicy: ["不得包含平台禁止内容"] }));

  console.log("审计报告：");
  console.dir(auditResult, { depth: null });
  console.log("内容审查报告：");
  console.dir(censorResult, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "审计或内容审查 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
