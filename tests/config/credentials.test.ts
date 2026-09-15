import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret } from "../../src/config/credentials";

test("加解密仅接收字符串和密钥，直接返回字符串", () => {
  const key = randomBytes(32).toString("hex");
  for (const value of ["fake-secret", "", "中文与符号 🔑", "  spaces  "]) {
    const encrypted = encryptSecret(value, key);
    assert.equal(typeof encrypted, "string");
    assert.equal(decryptSecret(encrypted, key), value);
    assert.notEqual(encrypted, encryptSecret(value, key));
  }
});

test("拒绝无效密钥、被篡改的密文及无效格式", () => {
  const key = randomBytes(32).toString("hex");
  const value = encryptSecret("fake-secret", key);
  assert.throws(() => decryptSecret(value, randomBytes(32).toString("hex")), /decryption failed/);
  assert.throws(() => encryptSecret("fake-secret", "bad"), /64 hexadecimal/);
  assert.throws(() => decryptSecret(value, "bad"), /64 hexadecimal/);
  const damaged = value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
  assert.throws(() => decryptSecret(damaged, key), /decryption failed/);
  assert.throws(() => decryptSecret("plaintext", key), /format/);
});
