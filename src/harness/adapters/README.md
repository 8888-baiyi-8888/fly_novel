# Harness 外部适配器

## 职责

将外部模型服务和存储机制接入 Harness 的内部契约。

## 内容范围

models/ 提供模型接入实现，persistence/ 提供运行记录和检查点的存储实现。

## 边界

依赖 Harness 契约实现适配；供应商和存储技术的细节不向 Agent 或小说业务传播。
