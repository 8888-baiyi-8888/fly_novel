# @fly-novel/map

地图 JSON 格式、受控文件存储、查询和模型工具插件工作区包。数据设计见[地图数据和工具契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-map-contract.md)。调用方显式提供可信文件后端和授权。

`parseWorldMap`、`parseMapPlace` 和 `parseMapConnection` 严格验证版本 1 的 JSON：先检查 JSON 语法，再使用项目已有的 `yaml` 解析器检查重复键，并通过 `zod` 校验结构。它们拒绝未知版本、额外字段、无效 ID、重复父级、越界或零面积范围和无效连通端点。`formatMapDocument` 仅序列化已通过校验的文档。已有世界资料不会自动导入或迁移。

`MapStore.open` 接收可信 `FileSystem`、世界 ID、地图根、访问模式和 `singleWriterProcess: true`；地图根、`places/`、`connections/` 必须已经是现有真实目录，由应用负责准备。本包不创建或清理目录；同进程同世界或同地图根不能重复打开。`maxDocumentBytes` 默认 1 MiB，`maxDocuments` 默认 10000，调用方可配置为正安全整数。读取过大文件由文件后端返回 `FS_TOO_LARGE`，扫描地点或连通目录超出数量限制返回 `MAP_LIMIT`。

存储提供世界概览、地点和连通文件的创建与按 ID 读取，以及按文件版本覆盖已有连通；地点 ID 和连通 ID 由程序生成。创建使用 `createIfAbsent`，连通更新使用从实际读取中核对的 `replaceIfVersion`；旧版本或目标已存在返回 `MAP_CONFLICT`。连通写入即为当前设定，地点与地图概览创建为建议。读取地点或连通、创建地点或连通时扫描并校验已记录地点图，拒绝未知层面、父级缺失、父级没有概况、跨层面引用及循环；损坏资料不会作为空结果跳过。

`MapQueries` 每次查询扫描世界概览、全部地点与连通文档，建立内存视图并校验身份、引用和文件版本；任一文档损坏或扫描受限时查询失败，不把缺失内容视为空。分页版本绑定扫描内容和查询条件，后续页需携带版本；新增、删除、修改相关文档或更改筛选条件时返回 `MAP_CONFLICT`。扫描结束前再次检查文件版本和目录清单，但不提供跨文件原子快照，也不防护不可信进程的并发替换。该实现按次扫描，没有长期缓存；每类目录数量受 `maxDocuments` 限制。

地点查询按层面跟随父级关系，子地点结果包含全部已记录父级与命中路径，`depth` 限制为 1 至 32，路径数量受限。`complete: false` 或 `truncated: true` 表示查询范围内存在未完成的遍历或缺失的几何信息，不表示世界本身已经被完整记录。空间查询使用实际矩形集合，独立报告边缘接触；逐层换算按选定父级路径计算，并以 `targetCanvas` 标明结果所属画布，父级覆盖可将子地点片段裁剪为该父级内的范围。同一地点到相同画布的多路径参考框相差超过 `0.000001` 时报 `MAP_CONFLICT`；参考框不足时标记 `consistency: incomplete`。世界画布结果按地图比例返回对应物理矩形坐标，不能当作道路里程。

`mapToolsPlugin` 使用可信应用传入的 `MapStore` 和访问模式注册当前 Agent 的地图工具，作用域释放时注销工具；存储和文件后端的生命周期属于调用方。`createMapTools(store, identity, access)` 也可供可信调用方显式注册；工具每次核对调用身份，`read-only` 不提供写工具，存储自身的只读约束仍然生效。创建和更新工具传递取消信号，提交结果不确定时返回 `status: unknown` 与供核查的相对路径。工具不会自动登记资料目录。`createMapDelegationTool` 为主 Agent 提供地图专用委派，世界与身份由可信应用绑定；参数和返回字段以工具 schema 与导出类型为准。

文件发布结果无法确定时抛出 `MAP_COMMIT_UNKNOWN`，携带地图根内相对路径供可信调用方核查；取消在后端确认未发布时保留 `FS_ABORTED`，不将其他失败一概视作回滚。读取拒绝符号链接和越出地图根的目标，但本机并发替换、硬链接和其他进程写入不由这些检查防护。调用方必须确保单可信写入进程、保护目录并按需要另行装配沙箱；`access: 'read-only'` 不替代操作系统权限。存储串行处理已受理的操作；`close()` 拒绝新操作、等待已受理操作并释放进程内占用，不关闭由调用方拥有的文件后端。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/map typecheck
pnpm --filter @fly-novel/map build
```
