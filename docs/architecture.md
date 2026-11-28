#初始化任务、第一版判断和只读恢复编排由可信应用入口统一装配；业务 Session 标识通过世界和主 Agent 身份派生为持久化标识。入口核对讨论前的第一版成果版本，用户审阅及发布动作不提供给模型工具。具体行为和资源归属见[应用说明](../src/app/README.md)。

 项目目录架构

本文用于开发时查阅项目根目录下各一级目录和文件的用途。目录内部的结构与细节由各目录自己的文档说明。

世界初始化的讨论模式由可信应用显式选择；主 Agent 和受委派专用 Agent 的文件能力为只读，Session 与业务成果分离。装配、当前限制及生命周期见[应用说明](../src/app/README.md)。

影响检查服务使用可信世界绑定读取模块资料并保存带范围版本的报告；复核不等于跨文件快照或确认提交。具体覆盖和生命周期见[世界初始化模块说明](../src/world-init/README.md)。

世界绑定的故事规划保存本轮采用的初始化交付与当前资料快照。导演提出地图需求后，由可信应用限定地点与来源，收取并核对一次场景级提案。场景记录保留来源和采纳依据，世界正文及正式发布由初始化业务服务管理。入口及保存规则见[故事应用说明](../src/app/README.md)和[故事模块说明](../src/story-workflow/README.md#世界绑定规划)。

故事角色参与以已保存的场景为边界。应用校验人物资料，逐角色组装获准认知，并在子故事内拥有角色实例及独立会话。参与请求和结果随业务记录重读，角色私有材料通过单独授权的入口访问。见[角色参与记录](../src/story-workflow/README.md#角色参与记录)。

场景内的互动由子导演分别判断逐角色感知及下一位回应者。应用保存事件、判断与调度，校验角色实际使用的观察后逐次启动一人。场景结算绑定可重读的互动证据。见[场景互动记录](../src/story-workflow/README.md#场景互动记录)。

可信应用可将已结算互动场景采用为事件，并据已确认的行动更新受授权的商队运行状态。版本化状态及回执独立于初始化交付和场景记录。启用世界证据的多层故事按事件与核实的当前状态回报和评估。见[商队运行状态](../src/story-workflow/README.md#商队运行状态)。

可信应用可在父故事的初步拆分保存后暂停推进，展示带期限和证据的安排审阅。应用保存用户或超时决定，随后单独领取推进位置。暂停期间没有常驻导演。见[父故事安排审阅](../src/app/README.md#父故事安排审阅)。

世界调度器记录获准的世界分钟和场景区间。可信应用在排期变更、领取和结算时串行核对资源，独立故事可并行演绎。场景结束后按证据交接角色位置、获准经历和共享状态版本。见[世界时间与并行故事](../src/app/README.md#世界时间与并行故事)。

可信应用持有审阅与受控发布服务；世界协调器串行化已接入入口的操作，发布记录、当前正文和候选分别保存并按实际状态恢复。多目标按用户选择逐项发布，部分失败时保留已发生结果并停止后续写入；目录状态单独核查。模型工具不获得确认或发布入口，单可信写入进程和协调范围仍由应用装配保证。具体格式与限制见[世界初始化模块说明](../src/world-init/README.md)。

| 目录或文件 | 用途 |
| --- | --- |
| `src/` | 项目源码与所属模块的测试，包含应用入口、配置管理、Agent 和工具。详见[源码目录说明](../src/README.md)。 |
| `src/agents/` | Harness 按 Agent 隔离插件服务；文件后端、观察策略与修改策略由可信调用方显式装配。[人物包](../src/agents/plugins/character/README.md)、[地图包](../src/agents/plugins/map/README.md)、[组织包](../src/agents/plugins/organization/README.md)、[历史包](../src/agents/plugins/history/README.md)、[初始局势包](../src/agents/plugins/initial-situation/README.md)、[世界发展规划包](../src/agents/plugins/world-development/README.md)和[世界专有内容包](../src/agents/plugins/world-specific/README.md)提供相应业务格式、存储、查询与工具。世界初始化入口和 Session 装配见[应用说明](../src/app/README.md)和 [Agent 包说明](../src/agents/README.md)。 |
| `src/world-init/` | 世界初始化业务能力的源码归属，包含世界工作区配置、进程内身份占用及资料目录服务。应用入口为主子 Agent 绑定目录权限，见[模块说明](../src/world-init/README.md)和[应用说明](../src/app/README.md)。 |
| `src/story-workflow/` | 故事级规划、多层模拟演绎、分批推进和整轮结果核查。导演由可信应用装配，见[模块说明](../src/story-workflow/README.md)。 |
| `docs/` | 面向开发者的项目架构、模块设计、业务工作流和工程决策文档。详见[文档协作规则](AGENTS.md)。 |
| `.agents/` | Agent 开发协作中的重要工程决策记录，说明问题、决定、影响与验证。 |
| `.fly-novel/` | 应用配置样例、本机配置和加密凭据；仅配置样例提交 Git。 |
| `.vscode/` | 本机 VS Code 调试与任务配置，受 Git 忽略规则保护。 |
| `.git/` | Git 管理的版本历史、索引和仓库元数据。 |
| `node_modules/` | 包管理器安装的第三方依赖，由依赖安装过程生成。 |
| `dist/` | 应用源码编译后的构建产物，由应用构建过程生成。 |
| `.test-dist/` | 测试及其依赖源码的编译产物，由测试编译过程生成。 |
| `tmp/` | 本地开发和验证过程中使用的临时文件，受 Git 忽略规则保护。 |
| [README.md](../README.md) | 项目介绍、环境要求、常用命令和开发文档入口。 |
| [AGENTS.md](../AGENTS.md) | 项目开发协作规则，规定代码、文档、测试与工程变更的约束。 |
| [.gitignore](../.gitignore) | Git 忽略规则，排除本机配置、凭据、依赖、构建产物和临时文件等内容。 |
| [package.json](../package.json) | 根项目的包信息、依赖声明，以及构建、类型检查、测试和工具启动脚本。 |
| [pnpm-workspace.yaml](../pnpm-workspace.yaml) | pnpm 工作区配置，登记由仓库统一管理的子包。 |
| [pnpm-lock.yaml](../pnpm-lock.yaml) | pnpm 生成的依赖锁文件，记录依赖解析结果，保证安装版本一致。 |
| [tsconfig.json](../tsconfig.json) | TypeScript 基础配置，供编辑器和源码、测试的类型检查使用，默认不生成编译产物。 |
| [tsconfig.build.json](../tsconfig.build.json) | 应用正式构建配置，继承基础配置，将应用编译到 `dist/`，排除测试和独立包源码。 |
| [tsconfig.test.json](../tsconfig.test.json) | 测试编译配置，继承基础配置，将源码与测试编译到 `.test-dist/`。 |
