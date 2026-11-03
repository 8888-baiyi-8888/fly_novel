# 具体工具

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { callId, name, workingDirectory, signal })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

`skill/` 是独立工作区包 `@fly-novel/skill-tool-core`，其 `createSkillTool(skills)` 使用可信调用方传入的 Skill 服务。[`tool-skill` 插件](../agents/plugins/tool-skill/README.md)已加入 Harness 内置注册表，依赖当前 Agent 的 `skills` 和 `tools` 服务，并随作用域注销工具。模型只传入名称；工具通过该服务查询与加载，不能指定来源或路径。文件系统来源检查授权工作目录、元信息、权限和文件边界；加载结果包含名称、来源、资源目录和正文。读取正文中引用的其他资源仍由对应工具独立授权。

Skill 来源注册和查询由 [`@fly-novel/skill`](../agents/plugins/skill/README.md) 提供，文件系统来源由 [`@fly-novel/skill-filesystem`](../agents/plugins/skill-filesystem/README.md) 提供。模型工具会拒绝调用被禁止模型调用的 Skill。`read_file` 的授权范围由其工作目录决定；Skill 返回的资源目录不会自动收紧该范围。

装配 `tool-skill` 后，每个模型 Step 前查询本实例的 Skill 来源，将允许模型调用的名称和用途作为 `<available_skills>` 摘要附加到系统消息，不提前发送正文；当工具不再可见或没有可用 Skill 时不展示目录。来源查询失败会终止本次请求，不把失败当作空目录。目录每次查询，不缓存；目录变化和空目录会替换后续请求中的旧内容。摘要随既有系统消息记录，恢复会话后在下次请求前重新查询，文件内容不会自动随构建产物分发。

Skill 服务、文件系统提供方和工具分别参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)、[文件系统提供方](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)和[工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/src/index.ts)。上游使用独立的持久化用户消息和目录变更事件；本项目使用现有系统消息，每个 Step 重新生成。当前不实现来源优先级、不完整目录、缓存、文件监听、扁平 Markdown、默认搜索目录或用户显式调用 Skill。YAML 元信息使用 `yaml` 解析，该依赖采用 ISC 许可证。

组合验证使用世界初始化主 Agent 的玄幻规划样例与另一个 Agent 的独立 Skill，固定模型替身先接收各自摘要，再调用 `skill` 工具；测试检查正文进入下一 Step、Session 中的调用和结果、猜测其他实例的名称以及实例销毁。固定替身不证明真实模型能够正确选择 Skill。

当前构建不会复制 `src/agents/world-initialization-main-agent/skills/` 的样例到 `dist/`，世界初始化主 Agent 的 Preset 由应用提供 `skill-filesystem.root`，不会自动定位源码目录。构建产物需要可信应用提供已经部署的 Skill 根目录，并将其置于授权工作目录内；不能假定部署环境存在源码目录。如果应用需要随产物分发该样例，应同时确定资源复制、部署位置和定位方式，并验证干净构建后的加载。

`defineTool` 将参数声明转换为模型可见的 JSON Schema，执行前校验参数，并声明规范输出与模型内容投影。服务执行工具后校验输出 schema，返回规范值与模型可见内容。schema 编译和校验的来源及许可证见[工具插件说明](../agents/plugins/tools/README.md)；模型可见 schema 不包含 `output` 和 `execute`。工具可直接调用，也可显式注册到 Agent 的 `tools` 服务。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
