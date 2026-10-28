# 调试 read_file 工具

本指南通过固定文件测试直接调用工具，不需要模型配置或凭据。在仓库根目录执行：

```powershell
pnpm run build:tests
node --test .test-dist/tools/tests/read-file.test.js
```

测试检查 UTF-8 内容、路径边界、文件类型、大小限制和无效编码。Windows 若缺少创建符号链接的权限，符号链接测试会报告跳过。

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

在[测试](../../src/tools/tests/read-file.test.ts)的 `readFileTool.execute(...)` 和[实现](../../src/tools/filesystem/read-file.ts)的路径检查、`file.read(...)` 以及返回语句处设置断点。按 F5 后观察 `args.path`、`exec.workingDirectory`、解析后的 `target` 和读取字节数；成功调用返回 `第一章：启程`。继续执行可观察越界、缺失文件和大小限制等拒绝路径。每次启动调试都会重新编译。
