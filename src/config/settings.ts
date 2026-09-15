import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_HOME } from "./paths";

/** 一次读取普通配置与全部凭据；密文保持原样，不读取加密密钥、不解密、不写文件。 */
export async function readSettings(): Promise<{
  settings: Record<string, unknown>;
  credentials: Record<string, string>;
}> {
  const settings = await readDocument("settings.json");
  const document = await readDocument(".credentials.json");
  if (typeof document.refs !== "object" || document.refs === null || Array.isArray(document.refs)) {
    throw new Error("Credentials refs must be an object");
  }
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(document.refs)) {
    if (typeof value !== "string") throw new Error("Credential values must be strings");
    Object.defineProperty(credentials, name, { value, enumerable: true });
  }
  return { settings, credentials };
}

/** 需要加解密时单独读取本机密钥；缺失时报错，不自动生成或替换。 */
export async function readEncryptionKey(): Promise<string> {
  try {
    return (await readFile(join(APP_HOME, ".encryption-key"), "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Encryption key is missing; restore .encryption-key");
    }
    throw error;
  }
}

async function readDocument(filename: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(APP_HOME, filename), "utf8");
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    throw new Error(`${filename} is not valid JSON`);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${filename} must be a configuration object`);
  }
  return { ...document };
}
