# 初始局势 Agent 验证

固定模型替身使用隔离世界走查主 Agent 委派、单一起点、多方案独立条目、关联、目录过期和跨世界读取拒绝；聚焦测试覆盖源资料版本、身份与目录绑定、取消、Session 恢复和不确定发布。固定替身不证明真实模型会正确规划或选择工具。

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/app/tests/initial-situation-agent-e2e.test.js .test-dist/app/tests/initial-situation-agent.test.js .test-dist/app/tests/initial-situation-references.test.js .test-dist/agents/tests/initial-situation-store.test.js .test-dist/agents/tests/initial-situation-tools.test.js
```

真实模型检查需要[本机模型配置](../../src/config/README.md)，会发送请求并产生费用。它在 `tmp/situation-real-*` 创建并保留独立世界和 Session，检查起点、方案与条目的实际文件；内容及未知项仍需人工审阅，不验证真实主 Agent 的委派或完整规划质量。

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/initial-situation-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

失败或结果不确定时先检查测试报告目录下的 Session 与实际文件，不假定没有创建；如需继续同一次测试，设置 `FLY_NOVEL_SITUATION_REAL_RESUME_ROOT` 为报告目录，保持 `FLY_NOVEL_REAL_LLM_TEST=1` 后重跑。入口恢复同一 Session 并要求核实成果；结束后清除两个环境变量。
