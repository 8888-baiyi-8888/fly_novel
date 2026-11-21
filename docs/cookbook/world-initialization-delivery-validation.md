# 世界初始化恢复与交付验证

本指南验证可信应用的任务、第一版判断、讨论、影响检查、受控发布、恢复和最终交付。运行环境见[项目入口](../../README.md)；目录布局、调用方责任和限制见[世界初始化模块说明](../../src/world-init/README.md)及[应用说明](../../src/app/README.md)。

## 固定模型与中断测试

在仓库根目录执行：

```powershell
pnpm run build:tests
node --test .test-dist/world-init/tests/initialization-delivery-e2e.test.js .test-dist/world-init/tests/recovery-orchestrator.test.js .test-dist/world-init/tests/recovery-task-store.test.js .test-dist/world-init/tests/recovery-discovery.test.js .test-dist/world-init/tests/batch-process-recovery.test.js
```

双世界样例在独立临时目录使用同名资料和固定模型替身，验证第一版、候选、确认、发布、交付及关闭后读取；一个子进程在交付记录写入后退出，恢复时按同一操作 ID 核对已保存结果。批次进程测试在正文发布后退出，按实际版本及显式决定恢复。其他测试覆盖未知版本、记录损坏、正文变化、重要冲突、活动候选暂留、未覆盖范围、响应丢失和启动清理。固定模型只验证脚本指定的调用路径，不证明模型的自主判断或其他世界的质量。

## 真实模型样例

真实模型样例会向本机配置的 DeepSeek 端点发送合成世界资料、提示词和工具定义，可能产生费用；运行前确认配置端点和发送范围已获授权。样例目录保留在 `tmp/`，供检查或恢复，不包含用户现有世界。程序中的用户确认是测试模拟，生产应用必须接收真实用户动作。

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST = '1'
node --test .test-dist/world-init/tests/initialization-delivery-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

该样例使用真实模型准备一个既有文件的待审修改，再由测试模拟用户选择、发布和完成；程序检查候选、原文隔离、发布结果与交付快照。人工仍需检查内容质量、未覆盖范围和留白；单个样例不验证十个模块或真实主 Agent 的所有委派路径。

## 上游能力与本项目边界

对照 DeepSeek Harness 固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` 的[Session 持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-persistence/README.md)、[JSONL 后端](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-persistence-jsonl/README.md)和[工具注册](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/README.md)：两者都提供 Session 句柄、持久化及工具注册能力。上游 JSONL 文档描述压缩、历史格式与崩溃恢复；本项目的 Session 后端使用独立的 JSONL 格式和自己的版本规则，不能把上游格式或恢复保证直接套用到本项目。项目的待审、用户确认和交付属于业务层，由可信应用与工具权限约束，不由 Session 或通用工具注册证明。项目工具实现的具体范围见[工具插件说明](../../src/agents/plugins/tools/README.md)。

本阶段的进程中断验证覆盖正文发布后与交付记录写入后两个边界，以及其他写入前后错误注入；这不是跨进程锁、跨文件事务或断电持久性的证明。未选世界正文、旧模块候选、未选人物索引和全世界语义一致性未由最终交付自动覆盖；后续世界演化接口尚未接入。历史重要冲突无法按现有证据证明已处理时会保守阻止交付；交付记录按 ID 查阅，单份上限 16 MiB。
