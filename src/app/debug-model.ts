import { readSettings } from "../config/settings";
import { callConfiguredLlm } from "./call-llm";
import { toLlmMessages } from "./configured-model";
import { buildDraftMessages } from "../novel/draft/prompt";
import { EXAMPLE_RAW_INPUT } from "../novel/draft/example";

/**
 * 调试入口：直接调用真实模型（qwen，走正式配置），打印原始返回内容（不经过 JSON 校验）。
 * 用于排查「模型返回了什么导致校验失败」。
 */
async function main(): Promise<void> {
  const { settings } = await readSettings();
  const provider = "qwen";
  const config = settings[provider];
  if (typeof config !== "object" || config === null || !("baseURL" in config) || !("model" in config)) {
    throw new Error(`供应商 ${provider} 未配置或缺少 baseURL/model，请先完成 .fly-novel/settings.json 配置`);
  }
  console.log(`端点: ${String(config.baseURL)}`);
  console.log(`模型: ${String(config.model)}`);
  console.log("正在请求（可能需要 30~90 秒），请耐心等待...\n");

  const text = await callConfiguredLlm({
    provider,
    messages: toLlmMessages(buildDraftMessages(EXAMPLE_RAW_INPUT)),
  });
  console.log("=== 模型原始返回（开头 3000 字符）===");
  console.log((text ?? "").slice(0, 3000));
  console.log("\n=== 总长度 ===");
  console.log(`${(text ?? "").length} 字符`);
}

main().catch((error: unknown) => {
  console.error("调试失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
