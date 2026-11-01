# 具体工具

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { callId, name, workingDirectory, signal })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

`skill/skill.ts` 提供 `createSkillTool(root)`，将可信调用方指定的绝对 Skill 根目录绑定到 `skill` 工具。模型只传入名称；工具通过 Skill 服务查找并加载 `名称/SKILL.md`，检查名称、描述、模型调用权限、大小和 UTF-8，并要求根目录位于授权工作目录内。Skill 目录或文件的符号链接解析后必须留在各自授权范围内；路径检查不防御其他进程在检查与打开之间替换目录或符号链接，调用方需保证目录不被不可信进程并发修改。加载结果包含 Skill 名称、文件系统来源、资源目录和正文，渲染为模型可见的 Skill 内容。读取正文中引用的其他资源仍由对应工具独立授权。

Skill 来源注册和查询由 [`@fly-novel/skill`](../agents/plugins/skill/README.md) 提供，文件系统来源由 [`@fly-novel/skill-filesystem`](../agents/plugins/skill-filesystem/README.md) 提供。模型工具会拒绝调用被禁止模型调用的 Skill。

Skill 服务、文件系统提供方和工具分别参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)、[文件系统提供方](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)和[工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/src/index.ts)。与上游不同，目前不实现来源优先级、不完整目录、缓存、文件监听、扁平 Markdown、默认搜索目录、Agent 自动绑定或会话目录发布。YAML 元信息使用 `yaml` 解析，该依赖采用 ISC 许可证。

`defineTool` 将参数声明转换为模型可见的 JSON Schema，执行前校验参数，并声明规范输出与模型内容投影。服务执行工具后校验输出 schema，返回规范值与模型可见内容。schema 编译和校验的来源及许可证见[工具插件说明](../agents/plugins/tools/README.md)；模型可见 schema 不包含 `output` 和 `execute`。工具可直接调用，也可显式注册到 Agent 的 `tools` 服务。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
