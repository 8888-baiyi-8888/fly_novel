# 审计 Agent

`AuditAgent` 按章节材料核对正文的剧情落实与一致性，使用调用方创建并注入的模型，通过 `invoke(content)` 接收序列化后的审计材料。它只返回报告，不修改正文或正式剧情状态。

## 检查范围

- Dispatch 要求回收、推进或提及的伏笔是否在正文中落实。
- 正文是否违反拍摄单中的角色限制或既定安排。
- 正文是否与角色模拟、场景表和事实快照冲突。

调用方应提供正文、Dispatch、场景表、角色模拟及本次审计所需事实材料。报告以 `PASS` 或 `FAIL` 开头。问题应引用可定位的正文内容，指出对应约束或事实、影响及修订方向；依据不足时明确说明无法判断。角色自主选择与导演安排不同本身不构成错误。

## 使用方式

```ts
import { AuditAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

declare const model: BaseLanguageModel;
const audit = new AuditAgent({ model });
const report = await audit.invoke(JSON.stringify({ draft, dispatch, scenesheet, simulations, facts }));
```

`AuditAgent` 不读取模型配置或凭据，也不读写小说文件。模型或 Deep Agents 调用错误由调用方处理。
