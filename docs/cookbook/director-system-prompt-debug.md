# 调试导演系统提示词

在 VS Code 的“运行和调试”中选择“调试导演系统提示词”并按 F5。启动配置先编译测试，使用固定 LLM Adapter，不需要模型配置或网络。

在[测试](../../src/agents/tests/director-system-prompt.test.ts)、[导演提示词插件](../../src/agents/director/system-prompt-plugin.ts)的 `section` 注册和 [Agent Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)组装提示词的位置设置断点。观察导演与角色各自的 `systemPrompt`、发送给模型的 `messages` 和导演实例销毁后的服务状态。

在仓库根目录也可运行：

```powershell
pnpm run build:tests
node --test .test-dist/agents/tests/director-system-prompt.test.js
```

本机没有启动配置时，可在 `.vscode/launch.json` 的 `configurations` 中添加：

```json
{
  "name": "调试导演系统提示词",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/.test-dist/agents/tests/director-system-prompt.test.js",
  "runtimeArgs": ["--test", "--test-isolation=none"],
  "cwd": "${workspaceFolder}",
  "preLaunchTask": "编译调试测试",
  "outFiles": ["${workspaceFolder}/.test-dist/**/*.js", "${workspaceFolder}/src/agents/dist/**/*.js", "${workspaceFolder}/src/agents/plugins/*/dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```
