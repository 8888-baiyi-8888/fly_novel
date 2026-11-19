# 世界发展规划 Agent 验证

固定模型替身在隔离世界检查主 Agent 委派、两个待审局势方案、宏观规划、故事线、角色成长线和成长蓝图的关联及实际文件；聚焦测试检查重复成长线、来源变化、版本冲突、权限失败、候选、取消、恢复和发布结果不确定。固定替身不证明真实模型能够正确规划或选择工具。

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/agents/tests/world-development.test.js .test-dist/app/tests/world-development-references.test.js .test-dist/app/tests/world-development-agent.test.js .test-dist/app/tests/world-development-agent-e2e.test.js
```

真实模型检查使用[本机模型配置](../../src/config/README.md)，会发送请求并产生费用；在 `tmp/development-real-*` 下保留隔离的世界资料和 Session。样例检查三类规划、未建档人物成长线与待审状态；内容和关联需人工审阅，不验证真实主 Agent 委派、完整规划质量或世界运行。

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/world-development-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

失败或结果不确定时先检查输出目录中的实际文件及 Session；需要继续同一次测试时，将 `FLY_NOVEL_DEVELOPMENT_REAL_RESUME_ROOT` 设为报告目录并保持真实模型开关，重新运行后恢复同一会话并要求模型先核查现有成果。结束后清除这两个环境变量。真实模型并不保证不会重复创建，恢复后仍需核对文件。
