# 将专用 Agent 接入章节流节点

## 问题

章节流的 direct、write、audit、censor 节点具有独立职责，但应用原先只向这些节点提供同一个通用生成端口。`src/agents` 已分别提供导演、写作、审计和内容审查 Agent。

## 决定

在章节图选项中为四个节点分别注入对应专用 Agent；节点直接调用其 `generate(content)` 并用 workflow 的共享解析函数读取 Deep Agents 输出。`merge` 与 `settle` 继续使用通用模型端口，`simulate` 继续使用 `CharacterAgentManager`。节点原有提示词、输入校验、PASS/FAIL 判定和重试路由保持在 workflow 层。

## 影响

章节应用负责创建四种专用 Agent；章节图选项明确记录各职责。workflow 仅在共享解析函数中读取 Deep Agents 消息结构，不增加应用层 Agent 包装器。

## 验证

运行根项目正式构建与 TypeScript 类型检查，确认专用 Agent 注入和既有测试替身符合新的章节图选项；不发起真实模型调用。
