# 调试 read_file 工具

本指南通过固定文件测试直接调用工具，不需要模型配置或凭据。在仓库根目录执行：

调试工具调用中断与 Session 恢复时，在 VS Code 选择“调试工具结果恢复”，并在[恢复测试](../../src/agents/tests/agent-loop-tool-recovery.test.ts)、[Agent Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)的工具调用分支和[恢复逻辑](../../src/agents/plugins/loop/tool-call-recovery.ts)设置断点。观察 `tool/call`、`tool/result` 的调用 ID 和错误码，以及下一次请求的消息历史。测试使用固定模型响应，不发起网络请求。

```powershell
pnpm run build:tests
node --test .test-dist/tools/tests/read-file.test.js
```

测试检查 UTF-8 内容、路径边界、文件类型、大小限制和无效编码。Windows 若缺少创建符号链接的权限，符号链接测试会报告跳过。

调试工具调用中断与 Session 恢复时，在 VS Code 选择“调试工具结果恢复”，并在[恢复测试](../../src/agents/tests/agent-loop-tool-recovery.test.ts)、[Agent Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)的工具调用分支和[恢复逻辑](../../src/agents/plugins/loop/tool-call-recovery.ts)设置断点。观察 `tool/call`、`tool/result` 的调用 ID 和错误码，以及下一次请求的消息历史。测试使用固定模型响应，不发起网络请求。

在 VS Code 中打开“运行和调试”，选择本机配置“调试 read_file 测试”并按 F5；启动前会自动执行“编译调试测试”。如果本机没有该配置，可在 `.vscode/launch.json` 的 `configurations` 数组添加：

```json
{
  "name": "调试 read_file 测试",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/.test-dist/tools/tests/read-file.test.js",
  "runtimeArgs": ["--test", "--test-isolation=none"],
  "cwd": "${workspaceFolder}",
  "preLaunchTask": "编译调试测试",
  "outFiles": ["${workspaceFolder}/.test-dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```

在[测试](../../src/tools/tests/read-file.test.ts)的 `readFileTool.execute(...)`、[工具定义](../../src/agents/plugins/tools/schema.ts)的参数校验和[实现](../../src/tools/filesystem/read-file.ts)的路径检查、`file.read(...)` 以及返回语句处设置断点。按 F5 后观察 `args.path`、`exec.workingDirectory`、`exec.signal`、解析后的 `target` 和读取字节数；成功调用返回 `第一章：启程`。继续执行可观察无效参数、取消、越界、缺失文件和大小限制等拒绝路径。每次启动调试都会重新编译。

## 调试工具服务

在“运行和调试”中选择“调试 Tools 服务测试”并按 F5。启动前自动编译测试。在[服务测试](../../src/agents/tests/tools-service.test.ts)和[工具服务](../../src/agents/plugins/tools/tools-service.ts)的 `register`、`schemas` 和 `dispose` 设置断点。观察两个 Agent 的独立服务、重复名称的错误、schema 副本、注销和销毁后的清理。服务测试使用固定适配器，不发起真实模型请求。

## 调试工具执行和 schema 校验

选择“调试 Tools 执行测试”并按 F5。启动前自动编译测试。在[执行测试](../../src/agents/tests/tools-execution.test.ts)的 `tools.execute(...)`、[工具服务](../../src/agents/plugins/tools/tools-service.ts)的 `execute`、[真实文件工具](../../src/tools/filesystem/read-file.ts)和 [schema 校验](../../src/agents/plugins/tools/json-schema.ts)的 `validateJsonSchemaValue` 设置断点。真实工具用例在临时目录写入文件，经服务读取后检查调用 ID、规范输出和模型内容；测试结束自动清理临时目录。其余固定工具用于检查不同 schema、错误和取消，不调用模型。

## 调试 Agent Loop 工具调用

选择“调试 Agent Loop 工具调用”并按 F5，启动前自动编译测试。在[闭环测试](../../src/agents/tests/agent-loop-tools.test.ts)、[Agent Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)的 `step`、[工具服务](../../src/agents/plugins/tools/tools-service.ts)的 `execute` 和[文件工具](../../src/tools/filesystem/read-file.ts)设置断点。固定适配器第一次返回 `read_file` 调用，第二次返回最终文本；观察两次请求、Session 的 `tool/call` 和 `tool/result` 以及相同的调用 ID。在两个 Agent 共用工具定义的用例中，观察 `exec.agent`、`exec.callId`、`exec.name`、`exec.signal` 和 `exec.workingDirectory`；两个实例读取不同临时目录，越界请求被拒绝。测试使用固定模型响应，不发起真实模型请求。

## 调试 Agent Loop 工具调用

选择“调试 Agent Loop 工具调用”并按 F5，启动前自动编译测试。在[闭环测试](../../src/agents/tests/agent-loop-tools.test.ts)、[Agent Loop](../../src/agents/plugins/loop/agent-loop-runtime.ts)的 `step`、[工具服务](../../src/agents/plugins/tools/tools-service.ts)的 `execute` 和[文件工具](../../src/tools/filesystem/read-file.ts)设置断点。固定适配器第一次返回 `read_file` 调用，第二次返回最终文本；观察两次请求、Session 的 `tool/call` 和 `tool/result` 以及相同的调用 ID。测试使用临时目录和固定模型响应，不发起真实模型请求。
