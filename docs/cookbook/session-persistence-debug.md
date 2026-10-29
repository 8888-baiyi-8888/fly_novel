# 调试 Session 持久化契约

## 调试 JSONL 后端

在 VS Code 选择“调试 Session JSONL 后端”并按 F5。测试使用临时目录，在[测试](../../src/agents/tests/session-persistence-jsonl.test.ts)和 [JSONL 后端](../../src/agents/plugins/session-persistence-jsonl/index.ts)的 `create`、`load`、`append` 和 `flush` 设置断点。观察文件头、事件序号、重新打开和不支持版本或不完整尾部的拒绝；测试结束会删除临时目录。

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
