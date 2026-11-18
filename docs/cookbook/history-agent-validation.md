# 历史 Agent 验证

固定模型替身在隔离世界中验证主 Agent 委派、历史事件与多上级子事件、未知时间、时间线、目录过期和跨世界读取拒绝；其他聚焦测试覆盖版本冲突、旧数据和损坏拒绝、取消、会话恢复及发布结果不确定。替身不证明真实模型会正确规划或选择工具。

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/app/tests/history-agent-e2e.test.js .test-dist/app/tests/history-agent.test.js .test-dist/app/tests/history-references.test.js .test-dist/app/tests/history-character-knowledge.test.js .test-dist/agents/tests/history-format.test.js .test-dist/agents/tests/history-store.test.js .test-dist/agents/tests/history-tools.test.js .test-dist/agents/tests/history-query.test.js
```

真实模型检查使用[本机模型配置](../../src/config/README.md)，会发送请求并产生费用。它在 `tmp/history-real-*` 创建并保留独立世界和 Session，要求保存战争与子事件并保留幕后原因未知；输出内容仍需人工审阅，不证明真实主 Agent 会正确委派或完整历史质量合格。

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/history-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

失败或结果不确定时先检查测试报告目录中的 Session 和已保存事件，不能假定没有创建。需要继续同一次测试时，设置 `FLY_NOVEL_HISTORY_REAL_RESUME_ROOT` 为该目录，保持 `FLY_NOVEL_REAL_LLM_TEST=1` 后重跑；入口恢复同一 Session 并要求核实已有成果。结束后清除这两个环境变量。
