// 一次性诊断：用 N1 的真实 prompt 调模型，打印原始输出（定位 coreNeed 缺失原因）。
const fs = require("node:fs");
const { buildDraftMessages } = require("../dist/novel-flow/draft/prompt.js");
const { toLlmMessages } = require("../dist/app/configured-model.js");
const { callConfiguredLlm } = require("../dist/app/call-llm.js");

(async () => {
  const raw = fs.readFileSync("artifacts/n0-raw-input/raw-input-20260928-111548.md", "utf8");
  const msgs = toLlmMessages(buildDraftMessages(raw));
  const text = await callConfiguredLlm({ provider: "qwen", messages: msgs, temperature: 0.2, maxTokens: 6000 });
  console.log("=== 模型原文（前 3000 字符）===");
  console.log(text.slice(0, 3000));
})().catch((e) => { console.error("诊断失败:", e.message); process.exit(1); });
