# 世界初始化业务模块

本目录用于组织世界初始化的业务能力，包括世界工作区、资料目录和资料读取；Agent 框架与通用文件工具分别位于 [`agents/`](../agents/README.md) 和 [`tools/`](../tools/README.md)。本目录是源码目录，不是运行时存放世界资料的工作区。

共享工作区与资料读取的范围、待确认事项和开发步骤见[第五阶段详细计划](../../docs/workflows/word-initialization/world-initialization-stage-5-workspace-plan.md)。业务代码和测试按实际实现建立；测试放在 `src/world-init/tests/`。

`workspace/config.ts` 的 `validateWorldWorkspaceConfigs` 校验可信应用提供的一组世界配置：每个世界包含稳定世界 ID、读取根、已确认资料根、资料目录保护根，以及主 Agent 和特殊 Agent 的稳定 ID 与专属目录。所有目录必须存在且使用绝对真实路径；同世界各专属目录和受保护目录位于读取根内且两两不重叠，世界 ID 和同世界 Agent ID 唯一，不同世界读取根不能重叠。函数返回冻结的配置快照，不修改目录。调用方须提供本次装配范围内的全部世界；该函数不保存配置、不锁定文件或目录，也不能防止本机并发替换和硬链接。应用装配及当前范围见[应用说明](../app/README.md)。

`workspace/agent-lease.ts` 提供按 `(世界 ID, Agent ID)` 区分的进程内身份占用。调用方在启动前取得占用，仅在启动回滚或资源释放成功后解除；清理失败时保留占用。该机制不记录持久映射或跨进程锁，也不会恢复记忆。

`workspace/catalog/` 包含工作区资料目录相关实现：`format.ts` 定义版本 1 JSON、严格解析和序列化；`initializeCatalog` 只在现有真实目录内独占创建 `catalog.json`，`readCatalog` 校验世界配置及可解析目标的重复别名。成果暂时缺失或不可访问时保留记录，未知版本、损坏、重复字段或重复目标拒绝读取。`path.ts` 的 `resolveCatalogTarget` 将可信世界和 Agent 身份与模型提供的规范相对路径结合，检查现有普通文件属于其专属目录，并返回真实目标的规范相对路径。它们不提供目录登记服务或模型工具；路径检查不能防止恶意进程并发替换及硬链接。

`character/format.ts` 提供角色资料与需求清单的版本化 YAML front matter 解析、序列化和校验；未知版本、重复字段及无效状态被拒绝。该模块不执行文件读写、角色 ID 分配或用户确认。YAML 使用 `yaml` 依赖，采用 ISC 许可证。

`character/store.ts` 由可信应用提供真实角色根目录，负责生成 UUID、保存角色建议、校验名称和分类索引、读取资料、保存待审修改以及在可信调用方确认后提交。`CharacterStore.open(root, true)` 仅初始化空目录；现有目录使用 `open(root)`，完成后调用 `close()`。`open(root, false, true)` 用于可信恢复操作，不自动处理损坏或未完成提交。重建已有索引前保留原索引备份。服务仅限制同一进程中重复打开同一角色根，调用方必须确保不存在其他写入进程并保护目录免受未授权的普通文件工具修改；该服务不是系统级沙箱。提交通过原资料与候选摘要校验，文件或索引操作失败时可能留下待恢复状态，不能将失败视为整体回滚。资料工具见[工具说明](../tools/README.md)。
