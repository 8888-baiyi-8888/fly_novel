# 具体工具

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { workingDirectory, signal })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

`defineTool` 将参数声明转换为模型可见的 JSON Schema，执行前校验参数，并声明规范输出与模型内容投影。当前参数声明仅支持字符串，工具输出仅支持字符串；尚未实现官方完整 schema DSL 和执行流水线，输出校验由后续流水线负责。模型可见 schema 不包含 `output` 和 `execute`。工具可直接调用，也可显式注册到 Agent 的 `tools` 服务；服务尚不执行工具调用。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
