# 内容审查 Agent

`CensorAgent` 按调用方提供的平台内容规范审查正文，使用调用方创建并注入的模型，通过 `invoke(content)` 接收待审正文及适用规范。它只返回审查报告，不修改正文。

审查范围限于输入中明确提供的规范，不自行补充或扩展平台规则。报告以 `PASS` 或 `FAIL` 开头；每项违规需指出可定位的文本依据、对应规范、影响和修改建议。依据或规范不足时明确说明无法判断，不编造规则或引文，也不评价审查范围外的剧情质量。

## 使用方式

```ts
import { CensorAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

declare const model: BaseLanguageModel;
const censor = new CensorAgent({ model });
const report = await censor.invoke(JSON.stringify({ draft, contentPolicy }));
```

`CensorAgent` 不读取模型配置或凭据，也不读写小说文件。模型或 Deep Agents 调用错误由调用方处理。
