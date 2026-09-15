import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { decryptSecret, encryptSecret } from "../config/credentials";
import { readEncryptionKey } from "../config/settings";

/** 独立开发入口：不接受命令行中的明文密钥，避免进入 shell 历史和进程参数。 */
async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["encrypt", "decrypt"].includes(command)) {
    throw new Error("用法：npm run credentials -- encrypt|decrypt");
  }
  const key = await readEncryptionKey();
  if (command === "encrypt") {
    const secret = await promptSecret("请输入 API Key（圆点显示，回车转换）：");
    console.log(encryptSecret(secret, key));
    console.error("仅返回密文，未保存文件；请自行复制到凭据文件对应字段。");
  } else {
    console.error("注意：以下是解密后的明文，请勿分享终端记录。");
    const value = await promptSecret("请粘贴完整密文（圆点显示，回车转换）：");
    console.log(decryptSecret(value, key));
  }
}

/** 输入仅回显圆点；关闭或取消后移除监听器，readline 负责恢复终端模式。 */
export async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("请在交互终端运行；不接受命令行或管道中的密钥");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  let finished = false;
  const renderMask = () => {
    if (finished) return;
    const count = Array.from(reader.line).length;
    const cursor = Array.from(reader.line.slice(0, reader.cursor)).length;
    // 仅显示光标附近的一行圆点，长密文不会换行后留下无法清除的残影。
    const width = Math.max(1, (process.stdout.columns || 80) - 1);
    const start = Math.max(0, cursor - width);
    const mask = "•".repeat(Math.min(count - start, width));
    const position = cursor - start;
    process.stdout.write("\r\x1b[2K" + mask + "\r" + (position ? "\x1b[" + position + "C" : ""));
  };
  process.stdin.on("keypress", renderMask);
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once("SIGINT", () => {
        finished = true;
        reject(new Error("已取消，未保存"));
      });
      reader.once("close", () => {
        finished = true;
        reject(new Error("输入已结束，未保存"));
      });
      reader.question(prompt + "\n", (value) => {
        finished = true;
        resolve(value);
      });
      muted = true;
    });
  } finally {
    finished = true;
    process.stdin.removeListener("keypress", renderMask);
    reader.close();
    output.destroy();
    process.stdout.write("\n");
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "凭据操作失败");
    process.exitCode = 1;
  });
}
