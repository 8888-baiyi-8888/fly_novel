# 具体工具

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { callId, name, workingDirectory, signal })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

`defineTool` 将参数声明转换为模型可见的 JSON Schema，执行前校验参数，并声明规范输出与模型内容投影。服务执行工具后校验输出 schema，返回规范值与模型可见内容。schema 编译和校验的来源及许可证见[工具插件说明](../agents/plugins/tools/README.md)；模型可见 schema 不包含 `output` 和 `execute`。工具可直接调用，也可显式注册到 Agent 的 `tools` 服务。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
