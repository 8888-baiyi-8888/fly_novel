# 应用配置与依赖组装

世界初始化可信部署可用 `mainMaxSteps` 设置主 Agent 每轮最大步数，各专用 Agent 配置可用 `maxSteps` 设置各自每轮上限；省略时使用 Agent Loop 默认的 10 步，提供的值必须是正整数。达到上限时报告 `MAX_STEPS`，已保存资料保留；恢复同一 Session 后可根据实际成果继续，不自动重试或证明任务完成。

`createOrganizationReferenceResolvers` 为可信组织存储绑定同世界的地图和人物引用校验，验证服务根目录属于工作区配置并复用已有存储句柄；调用方负责保持句柄有效并关闭它们。引用核验面向可信规划者，不能代替故事角色的读取授权。人物索引查询只在调用前后检查取消。

`createHistoryAgent` 根据可信世界配置和特殊 Agent 身份绑定历史负责人目录；`events/` 和 `candidates/` 必须预先存在。应用可借用同世界地图、人物和组织存储句柄核验引用；借用句柄由调用方持有和关闭，未提供解析器时关联引用无法核验。Session、目录服务和单可信写入进程要求与其他专用 Agent 一致；历史工具可读取完整事件，不是故事角色的认知视图。

世界初始化入口可选配置 `historyAgent`，为主 Agent 装配 `delegate_history` 并在启用资料目录时绑定历史负责人；未配置时不暴露该委派。历史 Agent 的文件保存、目录登记和回复均不代表用户确认。会话恢复不能证明历史任务完成。

`createCharacterCreator` 在角色专属根的 `relationships/` 下保存人物关系，首次使用时创建该子目录；已有角色索引和资料保持原格式。角色创建 Agent 装配人物关系工具和初始化更新工具，读取本人角色服务核验关系端点；已确认角色、已有候选和版本冲突按人物服务的规则拒绝直接覆盖。关系和角色资料保存不代表用户确认。调用方须确保同一世界只有一个可信写入进程，Agent 释放时先关闭工具作用域，再关闭人物关系和角色存储。

人物与关系的双世界固定替身走查和真实模型检查见[验证指南](../../docs/cookbook/character-relationships-validation.md)。

历史 Agent 的双世界委派走查及真实模型检查见[历史 Agent 验证指南](../../docs/cookbook/history-agent-validation.md)。

初始局势入口 `createInitialSituationAgent` 按可信世界、负责人目录和 Session 装配局势插件；可借用同世界历史、地图、组织和人物只读句柄。世界初始化部署配置可提供 `initialSituationAgent`，主 Agent 获得 `delegate_initial_situation`，不获得局势写工具。调用方负责准备负责人目录中的 `overviews/`、`situations/`、`candidates/` 和 Session 根，并等待 Agent 释放；已有目录服务可共享身份绑定。目录登记和保存不等于用户确认。

双世界固定替身和真实模型样例的运行方式与限制见[初始局势验证指南](../../docs/cookbook/initial-situation-agent-validation.md)。

世界发展规划入口 `createWorldDevelopmentAgent` 使用可信世界、负责人目录、Session 和联合规划插件，按配置借用初始局势、历史、地图、组织与人物的只读句柄。世界初始化部署配置可提供 `worldDevelopmentAgent`，主 Agent 使用 `delegate_world_development` 委派，不获得规划写工具。调用方准备[规划插件说明](../agents/plugins/world-development/README.md)列出的子目录和独立 Session 根，并负责借用句柄的生命周期。规划保存或目录登记不代表用户确认。

双世界固定替身与真实模型样例的命令和范围见[世界发展规划验证指南](../../docs/cookbook/world-development-agent-validation.md)。

世界专有内容入口 `createWorldSpecificAgent` 使用可信世界、负责人目录和 Session 装配[专有内容插件](../agents/plugins/world-specific/README.md)，按配置借用地图、组织、人物、历史、初始局势和世界发展规划的只读句柄。世界初始化部署配置可提供 `worldSpecificAgent`，主 Agent 使用 `delegate_world_specific` 委派，不获得专有写工具。调用方准备 `topics/`、`items/`、`candidates/` 和独立 Session 根，并管理借用句柄的生命周期；保存与目录登记不等于用户确认。

双世界固定替身和真实模型样例的运行方式及限制见[世界专有内容 Agent 验证指南](../../docs/cookbook/world-specific-agent-validation.md)。

可信应用可通过 `references` 借用已打开的地图和组织存储，并提供完整 `workspaces` 配置；主 Agent 的世界工作区入口提供世界配置。装配时校验世界 ID、负责人身份和目录，角色创建 Agent 只获得地图、组织的规划者只读工具，不能通过这些工具修改其他模块。借用句柄及其文件后端由调用方保持有效并关闭；角色创建 Agent 不自动打开、共享或关闭地图和组织 Agent 的存储。未提供引用时不注册相应结构化查询工具。此规划者视图不是故事角色的权限过滤，普通文件读取权限仍由工作区配置和调用方控制。

`createOrganizationAgent` 从可信世界配置中按特殊 Agent 身份取得组织根，调用前须建立真实的根目录及其 `organizations/`、`relations/`、`memberships/` 子目录；Session 根不能与任何传入世界读取根重叠。调用方提供世界和 Agent ID、Session ID 与模式、模型适配器及单可信写入进程保证，使用后须等待 `dispose()`。组织工具只在初始化期间读写，目录登记与成果保存分别报告；Session 恢复对话不证明业务完成。

组织配置可通过 `references` 提供可信应用持有的地图和角色存储及对应负责人身份，以核验同世界引用；这些句柄必须在组织 Agent 使用期间保持有效，仍由调用方关闭。未提供对应服务时，已关联引用无法核验，组织 Agent 可保存未关联线索。地图 Agent 自己打开的存储句柄不会自动共享给组织 Agent，若应用选择共享，须显式提供同一存储句柄，不能重复打开被占用的地图存储。

世界初始化入口同时配置地图 Agent 与其他引用地图的专用 Agent 时，由世界级共享地图存储向地图 Agent 提供读写能力，并向人物、组织、历史、局势、发展规划和专有内容提供各自已有的只读查询或引用核验能力；子 Agent 结束不会关闭共享地图，主 Agent 释放时等待子运行结束再关闭共享存储。此模式不能同时提供外部地图引用。独立入口仍由调用方负责显式借用的存储生命周期。

世界入口配置组织 Agent 时，共享组织存储供组织 Agent 写入及人物、历史、局势、发展规划和专有内容的只读工具或引用核验使用；不能同时提供外部组织引用。配置角色创建 Agent 时，人物及关系存储由世界入口持有并供引用方查询，组织核验人物时按需获取人物存储；不能同时提供外部人物或人物关系引用。

世界入口配置历史 Agent 时，历史存储由世界入口持有，历史 Agent 借用写入，局势、世界发展规划和专有内容按需借用历史引用；不能同时为这些消费者提供外部历史引用。关闭时先等待子 Agent，再按引用依赖关闭存储。

世界入口配置初始局势 Agent 时，其存储同样由世界入口持有，世界发展规划与专有内容可借用局势引用；不能同时提供外部局势引用。

世界入口配置世界发展规划 Agent 时，其存储由世界入口持有，专有内容可借用规划引用；不能同时提供外部规划引用。

世界入口配置世界专有内容 Agent 时，其存储也由世界入口持有，并在规划存储之前关闭；独立入口自行持有自己的存储。

共享地图与组织的[真实模型样例](tests/shared-world-storage-real.test.ts)需显式启用真实模型测试及有效的本机模型配置。该样例在隔离目录保存测试成果，结果仍须人工审阅。

跨模块第一版总览的双世界固定替身及真实模型样例见[整合验证指南](../../docs/cookbook/world-initialization-integration-validation.md)；真实模型样例只覆盖地图、组织、总览与会话恢复。

世界入口的部署配置可提供 `organizationAgent`，字段为 `agentId`、`sessionId`、`sessionMode`、`sessionRoot`、`provider`、`model`、`adapter` 及可选 `references`。组织身份不能与其他专用 Agent 相同；配置后主 Agent 获得 `delegate_organization`，组织写工具由组织 Agent 持有。启用目录时共用世界目录服务并绑定组织身份；父 Agent 关闭时取消并等待子运行释放。提示词指导职责和成果核查，不能保证真实模型遵循。

组织 Agent 的双世界固定替身走查和真实模型检查见[组织 Agent 验证指南](../../docs/cookbook/organization-agent-validation.md)。

`agents/` 分别提供世界初始化主 Agent、角色 Agent、导演 Agent 和写作 Agent 的创建函数。各创建函数从本机 DeepSeek 配置创建适配器，以当前工作目录为授权目录，并按各自工具列表逐项注册；单项失败时记录错误并继续创建。每次创建独立实例，调用方使用完毕后调用返回的 `agent.dispose()`。世界初始化主 Agent 使用当前目录下 `src/agents/world-initialization-main-agent/skills`，要求以仓库根目录启动；Skill 样例不随构建自动复制。

`createWorldInitializationAgentWithWorkspace` 接收可信应用显式指定的现有 `viewRoot`、`draftRoot` 和 `confirmedRoot` 绝对目录；创建前校验其真实路径与可写范围。它注册文件、搜索和委派工具，主 Agent 只能修改草稿根，通用子 Agent 只读；可选的角色创建 Agent 使用下文所述角色资料服务。已确认根不能与上游平台临时可写根重叠。内置 Skill 来源单独授权，Skill 正文可加载，但其资源路径不会因此自动成为文件工具的读取范围。该入口要求以仓库根目录启动，并适用于可信本地工作区；路径检查不能抵御恶意并发替换或硬链接。它不实现世界资料确认和持久化流程。

受控工作区为主 Agent 注册 `save_first_world_plan`：接收完整方案正文，在主 Agent 草稿根以独立名称创建带待审标题的 Markdown 文件，返回相对路径；创建条件禁止覆盖已有文件。结果为 `unknown` 时保留目标路径和错误信息，调用方须先核查实际状态，不能直接断定保存失败或成功。工具不会确认世界事实，也不验证正文完整性；是否在完整整合后调用及如何引用角色成果由主 Agent 决定。

受控入口根据实际工作区目录为主、子 Agent 分别注册文件权限提示词：主 Agent 获得草稿目录和路径示例，子 Agent 获得只读说明。提示词用于指导模型，实际访问仍由文件后端和读取授权检查执行。

`createCharacterCreator` 创建独立角色设定创建 Agent。可信应用显式提供世界和 Agent 身份、Session ID 及新建或恢复模式、现有的读取根、角色资料根、Session 根、模型适配器与默认生成数量；应用须在重新创建时提供相同的世界、Agent 和 Session ID。入口由三者派生存储用 Session ID，避免不同身份复用同名会话。角色根必须位于读取根内，Session 根与读取根不得重叠；角色根仅在明确指定初始化且为空时创建索引。Agent 注册角色资料工具及授权范围内的只读文件和搜索工具，返回的句柄负责运行、取消和等待释放。调用方必须 `await dispose()`，并确保同一世界没有其他进程同时写入；进程内相同身份或 Session 不允许并发启动。该独立入口不验证其他 Agent 的目录关系。

`createWorldBasicsAgent` 使用可信调用方提供的全部世界配置、世界 ID 和特殊 Agent ID 绑定世界基础信息 Agent 的读取根与专属目录；Session 根不得与任何传入世界读取根重叠。调用方提供模型、持久 Session 及单可信写入进程保证，使用后必须等待 `dispose()`；同世界相同身份在进程内独占。只读文件和搜索工具用于读取世界资料；`save_world_basics` 在专属目录以独立名称和 `createIfAbsent` 保存待审 Markdown，结果为 `unknown` 时按返回路径核查。可选目录服务须预先初始化，独立入口自行持有服务，同世界已有目录服务打开时不能再次打开；目录工具独立报告登记结果，保存和登记都不确认事实。恢复 Session 不证明业务任务完成；路径检查不提供跨进程锁或系统级隔离。

世界入口的部署配置可提供 `worldBasics`，以特殊 Agent 身份、Session 和模型配置装配 `delegate_world_basics`。主 Agent 提供任务和必要背景，世界、身份、目录与权限由工作区绑定；首次运行使用配置的 Session 模式，后续委派恢复同一 Session。角色创建与基础信息委派可同时装配并使用各自身份；启用目录时共享世界目录服务，各子运行使用独立绑定。父 Agent 关闭时取消并等待子运行释放；未配置时不注册该工具。主 Agent 的工作区提示词指导其将基础信息开发交给专用 Agent，并保留十模块之外的主动补充；提示词不保证真实模型遵循。

`createMapAgent` 为可信世界配置中指定的特殊 Agent 创建地图专用 Agent。该身份的 `writableRoot` 即地图根，调用前须建立真实的根目录及其 `places/`、`connections/` 子目录；Session 根必须是现有真实目录，且不能与任何传入世界读取根重叠。调用方提供世界 ID、Agent ID、Session ID、`create` / `resume` 模式、模型适配器及单可信写入进程保证。地图根、地图存储与工具权限由应用绑定，模型只能提供地图内容；地图工具返回相对地图根的路径，目录登记使用相对世界读取根的路径。使用完须等待 `dispose()`，取消和关闭不会删除已有地图文件。

世界入口的部署配置可提供 `mapAgent`，字段为 `agentId`、`sessionId`、`sessionMode`、`sessionRoot`、`provider`、`model`、`adapter`；从该身份的世界配置取得地图根，不能与角色创建或基础信息 Agent 使用相同身份。配置后主 Agent 获得 `delegate_map`，地图 Agent 通过地图插件执行读写；未配置时不注册该委派。启用目录时共享世界目录服务，地图 Agent 使用独立绑定；父 Agent 关闭时取消并等待子运行释放。Session 恢复对话历史，不证明地图任务已完成。提示词指导模型核实成果和遵守留白，但不能保证模型实际遵循。

地图模块的固定替身双世界走查与可选真实模型检查见[地图 Agent 验证指南](../../docs/cookbook/map-agent-validation.md)。真实模型检查使用隔离的临时世界，仅检验指定样例，不等于完整业务验收。

[基础信息端到端测试](tests/world-basics-e2e.test.ts)使用固定模型替身分别走查修仙世界和城邦群的主 Agent 委派、专用 Agent 保存及主 Agent 读取实际待审成果；目录登记、Session 恢复和失败处理分别由[委派测试](tests/world-basics-delegation.test.ts)与[独立入口测试](tests/world-basics.test.ts)覆盖。固定替身验证预设执行路径和状态，不证明真实模型正确规划、辨别来源或遵循留白。

`createWorldInitializationAgentWithWorkspace(workspace, characterCreator)` 可选接收可信角色创建配置，为主 Agent 装配 `delegate_character_creator`，通过 `persistent` Provider 委派；原有只读子 Agent 的 `delegate` 继续使用 `spawn`。角色读取根必须与主 Agent 读取视图一致，角色根必须位于视图内且与草稿根和已确认根不重叠，Session 根不能与读取视图重叠。首次成功启动按配置选择创建或恢复，后续委派恢复同一 Session。父 Agent 销毁会取消运行并等待子 Agent 清理。角色目录或 Session 初始化失败时保留已创建数据，调用方按实际状态重新配置；该入口不等于完整共享工作区隔离。

`createWorldInitializationAgentWithWorldWorkspaces` 接收可信应用提供的全部世界配置和选定世界 ID，并使用[世界工作区配置校验](../world-init/README.md)检查目录与身份关系。主 Agent 的草稿根绑定该世界主 Agent 的专属目录；角色和基础信息 Agent 的 `agentId` 必须属于该世界的特殊 Agent，各自目录从身份配置取得，模型不能指定这些授权。Session 根不得与任何传入世界的读取根重叠。主 Agent 的普通文件工具只能修改自己的目录；专用 Agent 通过各自工具维护成果，普通文件工具只提供读取和搜索。读取和搜索范围均为该世界读取根。调用方须传入 `{ singleWriterProcess: true }`，声明已确保同一世界只有一个可信应用进程写入；入口不会验证进程外的实际写入，也不提供跨进程锁。主 Agent 与专用 Agent 共用按世界和业务身份的进程内占用，启动到成功释放期间拒绝重复启动；清理失败保留占用。不同身份或世界不因身份相同而互斥。重建时调用方须继续提供相同的目录与 Session 配置。生产使用前须评估路径替换和硬链接风险。

部署配置传入 `discussion: { firstVersionComplete: true }` 可显式选择讨论装配；判断由可信调用方提供，不从 Session 或文件推断。普通文件工具、通用子 Agent 和按需委派的专用 Agent 只能读取与搜索，不借用初始化业务写句柄；初始化总览保存工具不可用。主 Agent 和专用 Agent 的讨论 Session 与初始化 Session 分离，恢复 Session 不改变当前工具权限。可选 `binding` 由可信应用提供讨论服务、讨论 ID 和可选关联目标，主 Agent 的候选工具只能使用这些目标；主 Session ID 必须与讨论记录一致。服务由调用方持有并关闭，候选目录不能与任一世界读取根或 Session 目录重叠。该模式暂不装配目录工具。

应用切换目标时关闭当前 Agent，并以另一讨论记录及其 Session 配置创建 Agent；返回原讨论时使用原 Session ID 和 `resume`。关联目标授权由可信应用重新提供；候选可通过讨论服务查询，显式放弃时调用服务的条件放弃操作。取消本轮、切换、子任务失败或关闭不会自动放弃已有候选；结果不确定时先按讨论查询。

讨论绑定可选提供同世界、同讨论服务的影响检查服务；主 Agent 与按需委派的专用 Agent 获得 `impact_check` 和 `impact_read`，仅能检查 / 读取授权目标的报告。报告目录不得与任一世界读取根、讨论根或 Agent Session 根重叠，服务与底层存储由可信调用方持有。检查结果是关联线索和覆盖范围，不代表自动完成语义冲突判断、用户确认或提交。

可信应用可通过 [`world-review.ts`](world-review.ts) 读取审阅全文和逐项正文差异，用于呈现用户选择；审阅和确认服务的身份、持久化与拒绝条件见[世界初始化业务说明](../world-init/README.md)。确认必须由可信应用接收明确用户动作，不能将确认服务作为 Agent 工具装配。

可信应用持有的受控发布服务按确认清单逐项执行，并向调用方返回发布及目录状态；部分失败须展示实际结果，后续目标重新检查并取得新的用户确认。发布服务和恢复选择不注册为模型工具，目录简介由负责人另行更新。装配和恢复约束见[世界初始化业务说明](../world-init/README.md)。

世界入口的部署配置可提供 `mainSession: { sessionRoot, sessionId, sessionMode }`，由可信应用使用 `create` 新建或 `resume` 恢复主 Agent 的 JSONL Session。`sessionRoot` 必须是现有绝对真实目录，不能与传入的任何世界读取根重叠；存储身份由世界 ID、主 Agent 身份和 Session ID 派生，重建时必须使用相同的值和目录。未提供配置时使用内存 Session。恢复后用户可在同一会话继续，主 Agent 根据历史和获授权工具核对成果并决定后续操作；中断工具结果未知时不得假设成功或盲目重试。持久化恢复的是会话历史，不保证模型正确排查，也不提供长期记忆。调用方须等待 `dispose()` 完成，后端随主 Agent 释放；已保存的世界成果不会因 Session 关闭而删除。

旧的 `createWorldInitializationAgentWithWorkspace` 主 Agent 没有世界业务身份，不参与新入口的身份占用；应用不能通过同时使用旧入口绕过同一世界目录的写入协调。角色资料服务和角色 Agent 的 `read_file` 直接访问文件，不产生普通文件工具的观察事件；观察策略本身不授予路径权限。角色 Session 恢复的是对话历史，不代表恢复长期记忆。

可信应用可在世界入口的部署配置中提供 `catalog: {}`（可配置目录及成果读取上限和凭据限制），为主 Agent 和角色创建 Agent 装配同一个世界资料目录服务及各自的工具。调用前须显式初始化 `catalog.json`；缺失或损坏会使装配失败，入口不会覆盖或修复文件。父 Agent 释放后关闭目录服务；每次角色 Agent 实例创建独立绑定并在释放时撤销其凭据。未提供目录配置时不注册目录工具，旧主 Agent 入口不自动启用。目录登记不确认事实；可查询、修改的范围及部署限制见[目录服务说明](../world-init/README.md)。

世界入口在启用资料目录时为主 Agent 提供其稳定负责人身份和已装配的负责人委派工具映射；角色创建配置存在时映射到 `delegate_character_creator`，未装配工具的身份不进入映射。检查、委派及复核由主 Agent 根据提示执行，模型不能通过委派参数指定身份、工作区或 Session；职责权限仍由可信绑定控制。

[资料目录对齐端到端测试](tests/catalog-alignment-e2e.test.ts)通过真实主子 Agent、目录工具和 Session，以及固定模型替身验证检查、委派、复核和未配置负责人的部分结果；该测试不验证真实模型是否遵循指引。

[世界工作区装配测试](tests/world-workspace-assembly.test.ts)验证同世界交叉读取、各自写入、跨世界及受保护目录拒绝、角色实例重建和 Session 复用；明确留白目前作为资料文件内容读取，不提供独立的结构化留白状态或业务解释接口。[双世界目录测试](tests/catalog-two-worlds.test.ts)还验证主 Agent 通过目录定位并读取本世界角色成果，成果变化后目录报告过期；这不保证跨文件版本一致或自动恢复生成进度。

[角色创建集成测试](tests/character-creator-integration.test.ts)使用固定模型替身验证主 Agent 委派、子 Agent 读取世界资料、创建多个角色、恢复 Session、按名称查找和保存待审修改；另验证读取缺失资料时错误和反馈在主子 Agent 之间传递。替身不验证真实模型的角色规划或工具选择能力。

[持续角色委派测试](tests/world-initialization-persistent-delegation.test.ts)覆盖未装配角色 Agent 时的资料读取、角色委派、子任务失败向主 Agent 传播以及取消和释放。固定模型替身按预设路径调用工具，不能证明真实模型会选择正确工具或完成第一版，也不能证明失败后自动恢复。

[世界工作区生命周期测试](tests/world-workspace-lifecycle.test.ts)覆盖主 Agent 生成失败后恢复同一 Session、重新读取已保存成果及继续输入，并验证不同世界的会话隔离；还覆盖角色创建后子任务失败、主子会话恢复、核查已有角色并保存总览。测试使用固定模型替身，不评估模型自主排查质量。

`agent_harness.ts` 提供 Cordis Harness 的独立调试函数 `debugAgentHarness(prompt)`，按角色 Preset 创建 Agent、读取本机 DeepSeek 配置并调用真实 Agent Loop，最后销毁实例。在仓库根目录运行 `pnpm run agent-harness-debug -- "你明天会回来吗？"`，或在 VS Code“运行和调试”中选择“调试 Cordis Agent Harness（DeepSeek）”并按 F5。该调试配置先构建 Agent 包和应用，可在函数、`AgentInstance.run()` 和 `AgentLoopRuntime` 中设置断点。

`world-initialization-debug.ts` 使用本机 DeepSeek 配置创建世界初始化主 Agent，在集成终端中直接输入并显示 Agent 回复；输入 `/exit` 结束。运行 `pnpm run world-initialization-debug`，或在 VS Code“运行和调试”选择“调试世界初始化主 Agent（DeepSeek）”并按 F5。调试入口以仓库为工作目录，使用仓库中的玄幻 Skill 样例；真实请求需要有效的模型配置和网络。此入口只测试 Agent 对话，不实现程序控制的确认和超时。

`world-initialization-files-debug.ts` 使用受控测试工作区和真实模型交互调试文件、搜索及委派工具，显示主 Agent 的工具调用；启动方式、测试任务和目录边界见[文件工具调试指南](../../docs/cookbook/world-initialization-file-tools-debug.md)。

`writer-agent-example.ts` 使用本地模型及凭据配置调用写作 Agent；运行前按[配置模块说明](../config/README.md)准备配置和凭据，也可用命令行参数选择 `settings.json` 中的提供商：

```bash
pnpm run writer-agent-example [provider]
```

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| agents/ | 各种 Agent 的应用层创建入口。 |
| tests/ | 应用入口与命令行交互测试。 |


[world-initialization-entry.ts](world-initialization-entry.ts) 的 `openWorldInitializationWorkflow` 是可信 Node.js 应用装配入口：调用方提供完整世界、现有隔离目录、本机文件后端、成果适配器、模块存储及全部 Session 根；入口组装协调器、讨论、检查、审阅、发布、任务和恢复服务，并返回交互 API 与异步关闭函数。调用方负责模型配置、借用资源及将确认动作绑定到真实用户；接口不实现独立图形界面。讨论启动前复核任务的第一版判断及 Session 关联，讨论 Agent 使用原有只读装配；检查、确认、发布和恢复通过可信应用显式调用。启动失败回收已打开资源，Agent 清理失败时保留业务资源和协调占用。

最终审阅和交付通过可信交互 API 调用；应用须向用户展示正文、候选和未覆盖项，接收逐项暂留、知悉及明确完成动作。交付记录保留历史正文；完成后修改不会改写该记录。存储目录、拒绝条件和保守限制见[世界初始化业务说明](../world-init/README.md)。
