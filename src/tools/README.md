# 具体工具

`character/delegate-character.ts` 提供角色专用工具 `createCharacterDelegationTool`。可信调用方使用同一父 Agent 的 SubAgent 服务和身份创建工具，并负责将其注册到该 Agent 的 Tools 服务；它直接使用 SubAgent 底层，不依赖通用委派工具包。模型提供任务和角色 ID，工具选择 `character-agent`，把 ID 作为创建参数交给子 Agent，前台等待结果并释放运行。角色 Agent 当前不会根据 ID 检索资料，模型所需的角色资料仍由调用方在任务中提供。

`index.ts` 是普通具体工具的统一导出入口，应用可以从该入口导入 `readFileTool` 和 `createCharacterDelegationTool`。Skill 工具使用其独立工作区包入口。

`character/character-tools.ts` 基于可信应用提供的角色资料服务创建角色资料工具；调用方负责注册与注销。工具提供角色创建、名称和分类查询、单个及批量读取、待审修改和需求清单读写；模型不能通过工具确认提交。角色资料服务与权限限制见[世界初始化模块说明](../world-init/README.md)。

`character/delegate-character-creator.ts` 创建角色设定专用委派工具 `delegate_character_creator`。可信调用方提供父 Agent 的 SubAgent 服务和身份并负责注册；模型只提供任务与背景，工具通过 `persistent` Provider 等待结果并释放运行。该工具与面向角色扮演的 `delegate_character` 不同。

`catalog/catalog-tools.ts` 基于可信目录身份句柄和当前工具服务的实例身份创建登记、更新、删除、查询及读取工具；模型不能指定世界、目录根或记录负责人。每次调用核对工具服务身份；登记不确认事实。`catalog_read_shared_source` 按目录记录 revision 读取同世界已登记成果，返回正文、内容摘要和目录过期状态，不提供更新凭据。更新简介前须通过 `catalog_read_source` 完整读取本人成果并获得一次性凭据，再向 `catalog_update` 提供对应的路径、revision 和凭据。目录变更操作在发布结果不确定时返回 `unknown`，调用方不能只根据工具是否报错判断是否提交。目录服务及访问范围见[世界初始化模块说明](../world-init/README.md)。

`catalog_check_page` 检查已登记成果的单页，返回负责人、文件状态及分页进度；取消时保留已完成结果。全量完成的判断与版本限制见[目录服务说明](../world-init/README.md)。

`filesystem/read-file.ts` 定义 `read_file`，通过 `execute({ path }, { callId, name, workingDirectory, signal })` 直接读取授权目录内不超过 1 MiB 的 UTF-8 普通文件。绝对路径、越界路径和解析后指向目录外的符号链接被拒绝；无效 UTF-8 和文件系统错误会使调用失败。授权目录必须由可信调用方提供，路径检查不保证抵御其他进程在检查与打开之间恶意替换目录或符号链接，调用方应确保授权目录不被不可信进程并发修改。

`skill/` 是独立工作区包 `@fly-novel/skill-tool-core`，其 `createSkillTool(skills)` 使用可信调用方传入的 Skill 服务。[`tool-skill` 插件](../agents/plugins/tool-skill/README.md)已加入 Harness 内置注册表，依赖当前 Agent 的 `skills` 和 `tools` 服务，并随作用域注销工具。模型只传入名称；工具通过该服务查询与加载，不能指定来源或路径。文件系统来源检查授权工作目录、元信息、权限和文件边界；加载结果包含名称、来源、资源目录和正文。读取正文中引用的其他资源仍由对应工具独立授权。

Skill 来源注册和查询由 [`@fly-novel/skill`](../agents/plugins/skill/README.md) 提供，文件系统来源由 [`@fly-novel/skill-filesystem`](../agents/plugins/skill-filesystem/README.md) 提供。模型工具会拒绝调用被禁止模型调用的 Skill。`read_file` 的授权范围由其工作目录决定；Skill 返回的资源目录不会自动收紧该范围。

装配 `tool-skill` 后，每个模型 Step 前查询本实例的 Skill 来源，将允许模型调用的名称和用途作为 `<available_skills>` 摘要附加到系统消息，不提前发送正文；当工具不再可见或没有可用 Skill 时不展示目录。来源查询失败会终止本次请求，不把失败当作空目录。目录每次查询，不缓存；目录变化和空目录会替换后续请求中的旧内容。摘要随既有系统消息记录，恢复会话后在下次请求前重新查询，文件内容不会自动随构建产物分发。

Skill 服务、文件系统提供方和工具分别参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)、[文件系统提供方](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)和[工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/src/index.ts)。上游使用独立的持久化用户消息和目录变更事件；本项目使用现有系统消息，每个 Step 重新生成。当前不实现来源优先级、不完整目录、缓存、文件监听、扁平 Markdown、默认搜索目录或用户显式调用 Skill。YAML 元信息使用 `yaml` 解析，该依赖采用 ISC 许可证。

组合验证使用世界初始化主 Agent 的玄幻规划样例与另一个 Agent 的独立 Skill，固定模型替身先接收各自摘要，再调用 `skill` 工具；测试检查正文进入下一 Step、Session 中的调用和结果、猜测其他实例的名称以及实例销毁。固定替身不证明真实模型能够正确选择 Skill。

当前构建不会复制 `src/agents/world-initialization-main-agent/skills/` 的样例到 `dist/`，世界初始化主 Agent 的 Preset 由应用提供 `skill-filesystem.root`，不会自动定位源码目录。构建产物需要可信应用提供已经部署的 Skill 根目录，并将其置于授权工作目录内；不能假定部署环境存在源码目录。如果应用需要随产物分发该样例，应同时确定资源复制、部署位置和定位方式，并验证干净构建后的加载。

`defineTool` 将参数声明转换为模型可见的 JSON Schema，执行前校验参数，并声明规范输出与模型内容投影。服务执行工具后校验输出 schema，返回规范值与模型可见内容。schema 编译和校验的来源及许可证见[工具插件说明](../agents/plugins/tools/README.md)；模型可见 schema 不包含 `output` 和 `execute`。工具可直接调用，也可显式注册到 Agent 的 `tools` 服务。逐步调试见[工具调试指南](../../docs/cookbook/tool-debug.md)。
