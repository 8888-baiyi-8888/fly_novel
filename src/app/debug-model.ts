import "dotenv/config";
import { OpenAICompatibleModel } from "../harness/adapters/models/openai-compatible-model";
import { buildDraftMessages } from "../novel/draft/prompt";
import { EXAMPLE_RAW_INPUT } from "../novel/draft/example";

/**
 * 调试入口：直接调用真实模型，打印原始返回内容（不经过 JSON 校验）。
 * 用于排查「模型返回了什么导致校验失败」。
 */
async function main(): Promise<void> {
  const apiKey = process.env.FLY_NOVEL_API_KEY;
  const baseURL = process.env.FLY_NOVEL_BASE_URL;
  const model = process.env.FLY_NOVEL_MODEL;
  if (!apiKey || !baseURL || !model) {
    throw new Error("缺少配置：FLY_NOVEL_API_KEY / FLY_NOVEL_BASE_URL / FLY_NOVEL_MODEL");
  }
  console.log(`端点: ${baseURL}`);
  console.log(`模型: ${model}`);
  console.log(`key 前6位: ${apiKey.slice(0, 6)}...（不打印完整 key）`);
  console.log("正在请求（可能需要 30~90 秒），请耐心等待...\n");

  const llm = new OpenAICompatibleModel({
    apiKey,
    baseURL,
    model,
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 150_000,
  });

  const resp = await llm.chat({ messages: buildDraftMessages(EXAMPLE_RAW_INPUT) });
  console.log("=== 模型原始返回（开头 3000 字符）===");
  console.log(resp.content.slice(0, 3000));
  console.log("\n=== 总长度 ===");
  console.log(`${resp.content.length} 字符`);
}

main().catch((error: unknown) => {
  console.error("调试失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
