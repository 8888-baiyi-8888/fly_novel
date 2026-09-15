import {
  callDeepSeek,
  type DeepSeekCallParameters,
} from "../llm/deepseek";
import { readSettings, readEncryptionKey } from "../config/settings";
import { decryptSecret } from "../config/credentials";

type ConfiguredDeepSeekParameters = Omit<
  DeepSeekCallParameters,
  "baseURL" | "apiKey" | "model"
> & { readonly model?: string };

/** 从完整配置中取出 DeepSeek 设置，在模型调用前解密对应 API Key。 */
export async function callConfiguredDeepSeek(
  parameters: ConfiguredDeepSeekParameters,
): Promise<string | null> {
  const { settings, credentials } = await readSettings();
  const config = settings.deepseek;
  if (typeof config !== "object" || config === null ||
      !("baseURL" in config) || typeof config.baseURL !== "string" || !config.baseURL.trim() ||
      !("model" in config) || typeof config.model !== "string" || !config.model.trim() ||
      !("credentialRef" in config) || typeof config.credentialRef !== "string" || !config.credentialRef.trim()) {
    throw new Error("DeepSeek requires non-empty baseURL, model and credentialRef");
  }
  const baseURL = config.baseURL.trim();
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("deepseek.baseURL must be a valid HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("deepseek.baseURL must use HTTP(S) without credentials, query or fragment");
  }
  const ref = config.credentialRef.trim();
  if (!Object.hasOwn(credentials, ref)) throw new Error("Credential reference was not found");
  const apiKey = decryptSecret(credentials[ref], await readEncryptionKey()).trim();
  if (!apiKey) throw new Error("DeepSeek API Key must be a non-empty string");
  return callDeepSeek({
    ...parameters,
    baseURL,
    apiKey,
    model: parameters.model ?? config.model.trim(),
  });
}
