# 验证人物与关系

本指南在隔离的临时世界验证角色创建 Agent、人物关系和主 Agent 委派。固定模型替身验证执行路径与状态，不证明真实模型会选择正确工具或合理规划人物。

在仓库根目录编译并运行聚焦测试：

```powershell
pnpm run build:tests
node --test --test-concurrency=1 .test-dist/app/tests/character-relationships-e2e.test.js .test-dist/app/tests/character-relationships-assembly.test.js .test-dist/agents/tests/character-relationship-store.test.js .test-dist/agents/tests/character-store.test.js
```

双世界测试检查主 Agent 委派、实际关系文件、两端查询、目录过期、跨世界读取拒绝及旧角色待审候选保留。其他聚焦测试覆盖只读跨模块绑定、身份、恢复、取消、写入结果不确定和资源释放。

准备[模型配置和凭据](../../src/config/README.md)后，可运行真实模型测试：

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/character-relationships-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

真实模型测试会产生实际模型请求，并在 `tmp/character-real-*` 保留独立世界和 Session。测试检查两位人物、待审状态、师徒关系和指定方向的单向信任；文本质量仍需人工审阅。失败或结果不确定时先查看测试输出的目录及已保存成果，不能盲目重复创建。该测试不检验真实主 Agent 委派或角色视角权限。

需要继续失败的同一次测试时，将 `FLY_NOVEL_CHARACTER_REAL_RESUME_ROOT` 设置为该次输出的测试目录，保持 `FLY_NOVEL_REAL_LLM_TEST=1` 后重新运行测试。入口恢复同一个角色 Agent Session 并输入“继续”，不重新初始化角色资料；使用结束后清除该环境变量。
