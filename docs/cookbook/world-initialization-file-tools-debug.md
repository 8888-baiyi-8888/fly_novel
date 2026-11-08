# 使用真实模型调试世界初始化文件工具

本指南通过 VS Code 和 DeepSeek 测试主 Agent 的文件读取、搜索、草稿修改和子 Agent 委派。调试程序使用独立的本地测试目录；模型回复和工具调用会显示在集成终端中。真实请求需要网络、模型服务和可用额度。

## 准备

1. 在 VS Code 中打开项目根目录，安装项目依赖：`pnpm install`。
2. 按[配置模块说明](../../src/config/README.md)准备本机 DeepSeek 模型配置、加密凭据和密钥；不要把真实密钥放入仓库文件。
3. 程序首次运行时会创建 `tmp/world-initialization-files-debug/draft/` 和 `tmp/world-initialization-files-debug/confirmed/`。已有文件不会被初始化程序覆盖；如果希望测试读取已确认资料，可在 `confirmed/` 下自行创建测试文本。

`tmp/world-initialization-files-debug/` 是读取视图，`draft/` 是主 Agent 的可修改目录，`confirmed/` 用于测试只读资料。子 Agent 只能读取和搜索。若项目位于系统临时目录，已确认资料根可能与上游临时可写根重叠，程序会拒绝启动；请将项目放在非系统临时目录。

## 在 VS Code 中启动

选择“运行和调试”中的 **调试世界初始化文件工具（真实 DeepSeek）**，按 F5。VS Code 会先构建项目，然后在集成终端显示三个测试目录。输入任务并回车；输入 `/exit` 结束。每轮输出包括本轮主 Agent 的工具名称、参数、调用结果状态和最终回复。子 Agent 的内部调用属于独立会话，不在此处逐条显示；委派工具返回后可查看主 Agent 的结果。

`.vscode/` 是本机忽略目录。如果调试列表没有该配置，将以下项目加入本机 `.vscode/launch.json` 的 `configurations` 数组：

```json
{
  "name": "调试世界初始化文件工具（真实 DeepSeek）",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/dist/app/world-initialization-files-debug.js",
  "cwd": "${workspaceFolder}",
  "preLaunchTask": "构建项目",
  "outFiles": ["${workspaceFolder}/dist/**/*.js", "${workspaceFolder}/src/**/dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**", "${workspaceFolder}/node_modules/**"]
}
```

如果本机 `.vscode/tasks.json` 没有“构建项目”任务，将以下项目加入其 `tasks` 数组：

```json
{
  "label": "构建项目",
  "type": "shell",
  "command": "pnpm",
  "args": ["run", "build"],
  "options": { "cwd": "${workspaceFolder}" },
  "problemMatcher": "$tsc"
}
```

也可在项目根目录终端执行 `pnpm run world-initialization-files-debug`，不经过 VS Code 调试器。

## 试用任务与核对

可以依次输入以下任务，观察终端中的实际工具调用，并在 VS Code 文件浏览器中查看测试目录：

1. `请在 draft 下创建 world.txt，写入一段简短的修仙世界设定。`
2. `请搜索草稿中的 world.txt，读取它，将设定改成以剑修为主，并告诉我修改了什么。`
3. 在 `confirmed/` 中自行创建 `fact.txt` 后输入 `请读取 confirmed/fact.txt，然后尝试修改它。` 检查文件内容保持不变。
4. `请委派子 Agent 搜索并读取 confirmed/fact.txt，让它尝试修改该文件，再报告结果。` 检查资料内容保持不变。
5. `请通过补丁删除 draft/world.txt。` 检查草稿文件是否被删除。

模型可能选择不同的工具、拒绝任务或生成不同内容；以终端的实际调用、工具结果和磁盘状态判断。`apply_patch` 的工具结果可能包含逐项报告，调用成功本身不等于每项修改都成功。终端展示的是本轮调用摘要；查看详细工具结果可在调试器中检查 Session，或运行固定模型测试：

```powershell
pnpm run build:tests
node --test .test-dist/app/tests/world-initialization-files-e2e.test.js .test-dist/app/tests/world-initialization-workspace.test.js
```

工作区路径检查和文件沙箱属于应用层保护，不抵御恶意本地并发替换或硬链接。示例不实现世界资料确认、业务持久化或系统级隔离，不要将正式资料放入测试目录。
