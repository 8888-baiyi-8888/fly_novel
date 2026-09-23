# 角色 Agent 模型调用样例

问题：角色 Agent 已能通过注册运行时调用 Deep Agents，但缺少使用项目本机 DeepSeek 配置的可执行调试入口。

决定：在应用层增加 `character-agent-example` 命令。入口读取现有 DeepSeek 设置、解密对应凭据，使用 OpenAI 兼容的 LangChain 适配器创建模型，注册 `configureAgentRuntime` 后调用 `CharacterAgent`。模型适配与凭据读取保持在应用层，不放入 Agent 包。

影响：开发者可用本机配置验证当前的模型调用链。样例不读取或写入角色档案、记忆和状态，只输出 Deep Agents 原始结果。

验证：类型检查和构建验证样例入口；真实调用要求本机提供有效 DeepSeek 配置与凭据，不能由自动化测试替代。
