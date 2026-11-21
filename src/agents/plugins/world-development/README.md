# @fly-novel/world-development

世界初始化中宏观发展蓝图、故事线、角色成长线与人物成长蓝图的版本化 JSON、受控存储、查询和工具；业务范围及文件契约见[联合开发计划](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-world-development-plan.md)和[资料契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-world-development-contract.md)。

规划候选校验检查已有文档身份、关联图、原线索和外部引用，不写入正文；候选保存和版本归讨论服务管理。

`DevelopmentStore.open` 要求可信世界、现有真实根、文件后端、访问模式、初始化阶段与单可信写入进程声明；根下必须事先创建 `macro-development/blueprints`、`macro-development/directions`、`macro-development/proposals`、`storylines/stories`、`storylines/growth-lines`、`character-growth/blueprints`、`character-growth/items` 和 `candidates`。调用者拥有后端、外部解析器及其生命周期；同世界或同根在本进程内不能重复打开，关闭等待已受理操作。这不是跨进程锁或系统级隔离。

每份文档包含世界、类型、UUID、审核状态、名称、概况、正文、留白、适用性、外部引用、内部关联及可选人物。类型为 `growth-line` 时必须绑定人物 ID 或未关联线索，其余类型不能绑定人物。已关联人物通过可信解析器核验，同世界一个人物只能有一条成长线；线索绑定时重新检查。两个总览各允许一份；多个方向和故事线按需创建，关联保留主动记录的类型、ID 和方向。初始化待审资料按版本更新，已确认资料只能准备候选，候选确认与世界演化留存没有实现。

局势适用性区分 `unknown`、明确声明的 `general` 和按方案分别说明的 `scoped`；可信局势解析器核对方案及条目归属。按方案搜索先核验方案，返回明确适用的规划和单独的未判断项，并逐项报告已引用局势条目的核验状态；已记录方案版本与当前版本可比较，但模型提供的版本不证明其真实读取。扫描和引用不提供跨文件原子快照或语义冲突裁决。`developmentToolsPlugin` 按可信身份注册工具，只读模式不提供写工具；完整资料不适合作为故事角色认知。

未知版本、重复键、损坏、跨世界、未授权和不一致的关联拒绝；发布结果不确定时返回目标路径，应核查实际文件再决定是否重试。目录登记与规划保存分开；Session 仅恢复对话，不证明任务已完成。
