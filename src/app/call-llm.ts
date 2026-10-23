import { Context } from "@deepseek-ai/cordis";
import { getAdapterFactory } from "./llm-adapters";
import { LlmRuntime } from '@fly-novel/llm';
import { LlmError } from '@fly-novel/llm';
import type { GenerateOptions, LlmAdapter } from '@fly-novel/llm';
import { readSettings, readEncryptionKey } from "../config/settings";
import { decryptSecret } from "../config/credentials";

type ConfiguredLlmParameters = Omit<
  GenerateOptions,
  "model"
> & { readonly model?: string };

/** 读取应用配置并创建已解密凭据的适配器；不注册模型路由。 */
export async function loadConfiguredAdapter(providerName: string, modelOverride?: string): Promise<{
  provider: string;
  model: string;
  adapter: LlmAdapter;
}> {
  const provider = providerName.trim();
  const createAdapter = getAdapterFactory(provider);
  const { settings, credentials } = await readSettings();
  if (!Object.hasOwn(settings, provider)) throw new Error(`缺少供应商配置：${provider}`);
  const config = settings[provider];
  if (typeof config !== "object" || config === null ||
      !("baseURL" in config) || typeof config.baseURL !== "string" || !config.baseURL.trim() ||
      !("model" in config) || typeof config.model !== "string" || !config.model.trim() ||
      !("credentialRef" in config) || typeof config.credentialRef !== "string" || !config.credentialRef.trim()) {
    throw new Error(`供应商 ${provider} 必须配置非空 baseURL、model 和 credentialRef`);
  }
  const baseURL = config.baseURL.trim();
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("baseURL 必须是有效的 HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseURL 必须使用 HTTP(S)，且不能包含凭据、查询参数或片段");
  }
  const model = modelOverride?.trim() ?? config.model.trim();
  if (!model) throw new Error("model 必须是非空字符串");
  const ref = config.credentialRef.trim();
  if (!Object.hasOwn(credentials, ref)) throw new Error("Credential reference was not found");
  const apiKey = decryptSecret(credentials[ref], await readEncryptionKey()).trim();
  if (!apiKey) throw new Error("API Key 必须是非空字符串");
  return { provider, model, adapter: createAdapter({ baseURL, apiKey }, config) };
}

/** 按 provider 选择配置和适配器，在模型调用前解密对应凭据。 */
export async function callConfiguredLlm(
  parameters: ConfiguredLlmParameters,
): Promise<string | null> {
  const { provider, model, adapter } = await loadConfiguredAdapter(parameters.provider, parameters.model);
  const runtime = new LlmRuntime(new Context());
  const unregister = runtime.registerAdapter([provider], adapter);
  let text: string | null = null;
  try {
    const stream = runtime.stream({ ...parameters, provider, model });
    for await (const chunk of stream) {
      if (chunk.type === "block-end" && chunk.block.type === "text") text = (text ?? "") + chunk.block.text;
      if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
        const failure = chunk.reason.failure;
        throw new LlmError(failure.message, failure.code, failure);
      }
    }
    return text;
  } finally { unregister(); }
}
