# 验证组织 Agent

本指南使用隔离的临时世界验证组织 Agent。固定模型替身检查主子 Agent、工具、存储和权限路径；真实模型检查会发送实际请求，产生的内容仍须人工审阅。

在仓库根目录编译并运行聚焦测试：

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/app/tests/organization-agent-e2e.test.js .test-dist/app/tests/organization-agent.test.js .test-dist/app/tests/organization-references.test.js .test-dist/agents/tests/organization-query.test.js .test-dist/agents/tests/organization-store.test.js
```

双世界走查通过主 Agent 委派组织 Agent，检查组织、关系、已关联人物和地点、未关联成员、成员双向查询、目录登记和更新、跨世界读取拒绝；其他测试覆盖等级过滤、版本冲突、保存结果不确定、恢复及资源释放。固定替身不证明真实模型能够正确规划或选择工具。

按[模型配置说明](../../src/config/README.md)准备 DeepSeek 配置和凭据后，在同一个 PowerShell 窗口执行：

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/organization-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

测试在 `tmp/organization-real-*` 新建并保留独立世界和 Session，输出实际目录。测试读取一份背景并要求模型创建两个组织、一条双向关系及未建档成员线索；检查实际 JSON、审核状态、留白和回复中的来源。测试不装配资料目录，也不验证真实主 Agent 委派、角色权限或规划质量；请求失败或断言失败时先检查已保存内容，不盲目重试创建。
