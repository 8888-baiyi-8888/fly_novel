# 具体工具

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { workingDirectory })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

定义中的 `parameters` 是模型可见的 JSON Schema；模型可见 schema 由名称、描述和参数构成，不包含 `execute`。当前工具仅支持直接调用，尚未注册到 Harness。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
