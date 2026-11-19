# 世界专有内容 Agent 验证

固定模型替身使用隔离的修仙和航海世界，检查主 Agent 委派、读取背景与已授权地图、主题及多主题内容、目录过期、来源变化和跨世界读取拒绝。聚焦测试覆盖无需新增主题、继续完善已有主题、同名候选、引用权限、版本冲突、取消、恢复及发布结果不确定。固定替身只验证预设路径，不证明真实模型会自主识别正确主题或遵循全部留白。

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/agents/tests/world-specific-store.test.js .test-dist/agents/tests/world-specific-tools.test.js .test-dist/app/tests/world-specific-references.test.js .test-dist/app/tests/world-specific-agent.test.js .test-dist/app/tests/world-specific-agent-e2e.test.js
```

真实模型检查需要[本机模型配置](../../src/config/README.md)，会发送请求并产生费用；在 `tmp/specific-real-*` 中保留隔离世界和 Session。测试让 Agent 从世界背景自主识别并保存主题和关联内容，检查实际文件及待审状态；内容质量、未知和留白仍需人工审阅，不验证真实主 Agent 的委派。

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/world-specific-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

失败、达到步数上限或发布结果不确定时，先检查报告目录内的实际文件和 Session，不能认定没有写入；需继续同一次测试时，将 `FLY_NOVEL_SPECIFIC_REAL_RESUME_ROOT` 设为该目录并保持真实模型开关，重跑后恢复同一会话，要求模型先核实成果再补做或报告。完成后清除两个环境变量；恢复后仍须检查有无重复文件。
