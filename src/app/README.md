# 应用配置与依赖组装

`agents/` 分别提供世界初始化主 Agent、角色 Agent、导演 Agent 和写作 Agent 的创建函数。各创建函数从本机 DeepSeek 配置创建适配器，以当前工作目录为授权目录，并按各自工具列表逐项注册；单项失败时记录错误并继续创建。每次创建独立实例，调用方使用完毕后调用返回的 `agent.dispose()`。世界初始化主 Agent 使用当前目录下 `src/agents/world-initialization-main-agent/skills`，要求以仓库根目录启动；Skill 样例不随构建自动复制。

`createWorldInitializationAgentWithWorkspace` 接收可信应用显式指定的现有 `viewRoot`、`draftRoot` 和 `confirmedRoot` 绝对目录；创建前校验其真实路径与可写范围。它注册文件、搜索和委派工具，主 Agent 只能修改草稿根，通用子 Agent 只读；可选的角色创建 Agent 使用下文所述角色资料服务。已确认根不能与上游平台临时可写根重叠。内置 Skill 来源单独授权，Skill 正文可加载，但其资源路径不会因此自动成为文件工具的读取范围。该入口要求以仓库根目录启动，并适用于可信本地工作区；路径检查不能抵御恶意并发替换或硬链接。它不实现世界资料确认和持久化流程。

受控入口根据实际工作区目录为主、子 Agent 分别注册文件权限提示词：主 Agent 获得草稿目录和路径示例，子 Agent 获得只读说明。提示词用于指导模型，实际访问仍由文件后端和读取授权检查执行。

`createCharacterCreator` 创建独立角色设定创建 Agent。可信应用显式提供世界和 Agent 身份、Session ID 及新建或恢复模式、现有的读取根、角色资料根、Session 根、模型适配器与默认生成数量；应用须在重新创建时提供相同的世界、Agent 和 Session ID。入口由三者派生存储用 Session ID，避免不同身份复用同名会话。角色根必须位于读取根内，Session 根与读取根不得重叠；角色根仅在明确指定初始化且为空时创建索引。Agent 注册角色资料工具及授权范围内的只读文件和搜索工具，返回的句柄负责运行、取消和等待释放。调用方必须 `await dispose()`，并确保同一世界没有其他进程同时写入；进程内相同身份或 Session 不允许并发启动。该独立入口不验证其他 Agent 的目录关系。

`createWorldInitializationAgentWithWorkspace(workspace, characterCreator)` 可选接收可信角色创建配置，为主 Agent 装配 `delegate_character_creator`，通过 `persistent` Provider 委派；原有只读子 Agent 的 `delegate` 继续使用 `spawn`。角色读取根必须与主 Agent 读取视图一致，角色根必须位于视图内且与草稿根和已确认根不重叠，Session 根不能与读取视图重叠。首次成功启动按配置选择创建或恢复，后续委派恢复同一 Session。父 Agent 销毁会取消运行并等待子 Agent 清理。角色目录或 Session 初始化失败时保留已创建数据，调用方按实际状态重新配置；该入口不等于完整共享工作区隔离。

`createWorldInitializationAgentWithWorldWorkspaces` 接收可信应用提供的全部世界配置和选定世界 ID，并使用[世界工作区配置校验](../world-init/README.md)检查目录与身份关系。主 Agent 的草稿根绑定该世界主 Agent 的专属目录；可选角色 Agent 的 `agentId` 必须属于该世界特殊 Agent，角色资料根从该身份的专属目录取得，模型不能指定这些授权。角色 Session 根不得与任何传入世界的读取根重叠。主 Agent 的普通文件工具只能修改自己的目录；角色 Agent 通过专用资料工具维护角色目录，普通文件工具只提供读取和搜索。读取和搜索范围均为该世界读取根。此入口尚未提供其他特殊 Agent 的生产装配、统一持续身份互斥或跨进程写锁；测试中的第二个可写 Agent 使用相同的文件后端。应用必须确保同一世界只有一个可信进程写入，并在生产使用前评估路径替换和硬链接风险。

[角色创建集成测试](tests/character-creator-integration.test.ts)使用固定模型替身验证主 Agent 委派、子 Agent 读取世界资料、创建多个角色、恢复 Session、按名称查找和保存待审修改；另验证读取缺失资料时错误和反馈在主子 Agent 之间传递。替身不验证真实模型的角色规划或工具选择能力。

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
