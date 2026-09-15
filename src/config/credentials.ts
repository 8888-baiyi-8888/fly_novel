import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 加密字符串并返回密文，不读取或写入文件。
 * @param value 待加密的字符串。
 * @param key 32 字节密钥的 64 位十六进制字符串。
 * @returns gcm2 格式密文；密钥格式无效时抛出错误。
 */
export function encryptSecret(value: string, key: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("Encryption key must be 64 hexadecimal characters");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["gcm2", iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(":");
}

/**
 * 解密字符串并返回明文，不读取或写入文件。
 * @param value encryptSecret 返回的完整密文。
 * @param key 加密时使用的 64 位十六进制密钥。
 * @returns 明文；密钥无效、密文格式无效或损坏时抛出错误。
 */
export function decryptSecret(value: string, key: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("Encryption key must be 64 hexadecimal characters");
  if (!/^gcm2:[a-f0-9]{24}:[a-f0-9]{32}:(?:[a-f0-9]{2})*$/.test(value)) {
    throw new Error("Invalid encrypted credential format");
  }
  const [, iv, tag, data] = value.split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Credential decryption failed: wrong key or damaged ciphertext");
  }
}
