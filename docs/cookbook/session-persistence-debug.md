# 调试 Session 持久化契约

## 调试持久化端到端验收

在 VS Code 选择“调试 Session 持久化验收”并按 F5。在[验收测试](../../src/agents/tests/session-persistence-acceptance.test.ts)的模型请求、`flush`、重建 Agent 和恢复后的消息断言处设置断点；也可在 [read_file](../../src/tools/filesystem/read-file.ts) 和 [JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)设置断点。测试使用固定模型响应、真实文件工具和临时 JSONL 文件，无需网络和密钥；删除原文件后仍能恢复工具结果及其调用 ID。测试结束清理临时目录。

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/session-persistence-acceptance.test.js
```

若本机没有该启动配置，可在 `.vscode/launch.json` 的 `configurations` 中添加：

```json
{
  "name": "调试 Session 持久化验收",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/.test-dist/agents/tests/session-persistence-acceptance.test.js",
  "runtimeArgs": ["--test", "--test-isolation=none"],
  "cwd": "${workspaceFolder}",
  "preLaunchTask": "编译调试测试",
  "outFiles": ["${workspaceFolder}/.test-dist/**/*.js", "${workspaceFolder}/src/agents/dist/**/*.js", "${workspaceFolder}/src/agents/plugins/*/dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```

## 调试中断恢复和格式迁移

在 VS Code 选择“调试 Session 中断恢复”并按 F5。在[中断测试](../../src/agents/tests/agent-loop-interrupted.test.ts)、[恢复逻辑](../../src/agents/plugins/loop/interrupted-turn.ts)、[Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)的恢复和刷新位置及 [JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)的 `prepareWrite` 设置断点。测试使用临时文件，观察已开始与未开始的工具结果、`interrupted` Turn、v1 原文件保留及尾部修复。

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/agent-loop-interrupted.test.js
```

## 调试 Agent Loop 会话恢复

在 VS Code 选择“调试 Agent Loop 会话恢复”并按 F5。测试使用固定模型和临时 JSONL 文件。在[测试](../../src/agents/tests/agent-loop-persistence.test.ts)、[Agent Loop 初始化](../../src/agents/plugins/loop/agent-loop-runtime.ts)与 [JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)的 `create`、`open` 设置断点，观察 `sessionId` 与 `resumeSessionId`、恢复的模型消息、Turn 编号及失败路径。

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/agent-loop-persistence.test.js
```

## 调试 Session 保存与历史恢复

在 VS Code 选择“调试 Session 持久化恢复”并按 F5。在[恢复测试](../../src/agents/tests/session-persistence-recovery.test.ts)、[Session 追加和历史派生](../../src/agents/plugins/session/session.ts)、[Session Manager](../../src/agents/plugins/session/session-manager.ts)的 `flush`、[JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)的 `drain` 设置断点。测试写入临时文件，检查系统提示词、工具调用和结果的 ID、事件序号，以及写入失败后的显式重试；结束时清理临时目录。

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/session-persistence-recovery.test.js
```

## 调试 JSONL 后端

在 VS Code 选择“调试 Session JSONL 后端”并按 F5。测试使用临时目录，在[测试](../../src/agents/tests/session-persistence-jsonl.test.ts)和 [JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)的 `create`、`load`、`append` 和 `flush` 设置断点。观察文件头、事件序号、重新打开、不支持版本的拒绝及不完整尾部恢复；测试结束会删除临时目录。

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/session-persistence-jsonl.test.js
```

在 VS Code 的“运行和调试”中选择“调试 Session 持久化契约”并按 F5。启动配置先编译测试；测试使用内存后端，不写入文件，不需要网络。

在[测试](../../src/agents/tests/session-persistence.test.ts)的 `create`、`open`、`append`、`read`、`flush` 和 `close` 设置断点，观察 Session ID、事件序号、只读拒绝及关闭后的行为。[服务契约](../../src/agents/plugins/session-persistence/index.ts)定义 Cordis 服务入口，[句柄契约](../../src/agents/plugins/session-persistence/handle.ts)定义单会话操作。内存后端不提供崩溃后数据恢复。

也可在仓库根目录运行：

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/session-persistence.test.js
```

本机没有启动配置时，可在 `.vscode/launch.json` 的 `configurations` 中添加：

```json
{
  "name": "调试 Session 持久化契约",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/.test-dist/agents/tests/session-persistence.test.js",
  "runtimeArgs": ["--test", "--test-isolation=none"],
  "cwd": "${workspaceFolder}",
  "preLaunchTask": "编译调试测试",
  "outFiles": ["${workspaceFolder}/.test-dist/**/*.js", "${workspaceFolder}/src/agents/dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```
