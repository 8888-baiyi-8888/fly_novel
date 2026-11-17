# @fly-novel/organization

组织、组织间关系和成员关系的版本化 JSON 与初始化受控文件存储工作区包。业务范围和后续工作见[组织模块开发计划](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-organization-plan.md)，文件字段及校验见[组织数据契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-organization-contract.md)。本包不自动创建目录、注册模型工具或创建 Agent。

`parseOrganization`、`parseOrganizationRelation` 和 `parseOrganizationMembership` 检查 JSON 语法、重复键、版本及结构；未知版本、无效字段和非法权限等级被拒绝。`formatOrganizationDocument` 校验后序列化。所有 JSON 文件是新建的版本 1 格式，不自动导入现有角色分类、目录记录或其他资料；不支持的版本拒绝读取并保留原文件。

`OrganizationStore.open` 接受可信文件后端、世界 ID、组织根、访问模式、`phase: 'initialization'` 和 `singleWriterProcess: true`。组织根及 `organizations/`、`relations/`、`memberships/` 必须预先是实际存在的真实目录；同进程相同世界或根目录不能重复打开。调用方确保只有一个可信进程写入，并保护目录免遭未授权操作。声明 `phase` 不会检测实际世界状态：世界开始演化后，调用方不能使用此初始化入口覆盖资料，应等待历史留存能力另行实现。

组织文件保存名称、别名、可空的组织类型、独立展开等级、待审状态、分级正文、地点引用和明确留白；成员关系保存组织 ID、已关联角色 ID 或未关联线索、岗位、任期说明及最低等级；组织间关系保存两端组织 ID、关系语义、方向和两端最低等级。统属关系从子组织指向父组织，先校验端点存在且统属图无环；普通关系不根据名称推断方向或统属。一个组织可以有多个上级或同名组织。字段、引用验证和缺失语义见数据契约。

创建生成 ID 并独占写入；初始化更新读取当前版本，随后使用 `replaceIfVersion` 覆盖同一文件。冲突返回 `ORG_CONFLICT`，旧数据不被覆盖；发布结果无法确定返回 `ORG_COMMIT_UNKNOWN` 及相对路径，必须核查实际文件。已关联的人物或地点必须由可信应用绑定的 `resolvePerson` / `resolvePlace` 在写入时核实世界和 ID；解析器未提供返回 `ORG_REFERENCE_UNAVAILABLE`，不同世界或未找到返回 `ORG_INVALID_DOCUMENT`。未关联线索不需要解析器。读取只表示写入时曾核实，不保证外部资料此刻仍存在、可读或未变化。解析器的隔离、正确性、超时与生命周期由可信调用方负责。

本存储的读取面向可信应用或规划者，返回完整原始文档；`minLevel` 等字段只是为后续实现提供数据结构，当前**不提供按角色的权限过滤或保护**，不能将该存储或原始文件直接交给需要隔离秘密的角色。角色查询视图、按等级过滤、工具注册和组织 Agent 均属于后续步骤；世界演化的历史快照及恢复流程也尚未实现。

`maxDocumentBytes` 默认 1 MiB，`maxDocuments` 默认每个目录 10000，均由可信调用方配置；读取超限返回后端 `FS_TOO_LARGE`，创建或扫描超限返回 `ORG_LIMIT`。本包检查真实目录、普通文件和链接边界，但不能抵御不可信进程并发替换、硬链接或跨进程写入。操作在同一存储句柄内串行；`close()` 拒绝新操作、等待已受理操作并释放占用，不关闭调用方的文件后端。存储不提供跨文件事务、历史版本或系统级隔离。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/organization typecheck
pnpm --filter @fly-novel/organization build
```
