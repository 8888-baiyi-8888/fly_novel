# 删除角色文件记忆

问题：真实模型调用超时，需要隔离结构化输出链路。

决定：删除角色记忆目录初始化、记忆提示、磁盘后端配置和目录锁；运行时仅要求模型解析器。通过模型调用中间件清空普通工具，仅保留框架结构化输出工具。保留实例内存检查点、顺序会话和并发保护；不删除已有本机记忆数据。

影响：新实例不加载旧角色文件，模型不能读写记忆；结构化输出策略和错误传播保持原有行为。

验证：pnpm run build:tests 后执行 node --test .test-dist/agents/tests/character-agent.test.js，14 项通过；pnpm run build、pnpm run typecheck 和 git diff --check 通过。未调用真实模型。
