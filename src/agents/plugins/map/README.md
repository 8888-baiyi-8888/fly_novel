# @fly-novel/map

地图 JSON 格式和受控文件存储工作区包。数据设计见[地图数据和工具契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-map-contract.md)。本包不自动注册 Cordis 服务或模型工具，也不创建 Agent；调用方显式提供可信文件后端和授权。

`parseWorldMap`、`parseMapPlace` 和 `parseMapConnection` 严格验证版本 1 的 JSON：先检查 JSON 语法，再使用项目已有的 `yaml` 解析器检查重复键，并通过 `zod` 校验结构。它们拒绝未知版本、额外字段、无效 ID、重复父级、越界或零面积范围和无效连通端点。`formatMapDocument` 仅序列化已通过校验的文档。已有世界资料不会自动导入或迁移。

`MapStore.open` 接收可信 `FileSystem`、世界 ID、地图根、访问模式和 `singleWriterProcess: true`；地图根、`places/`、`connections/` 必须已经是现有真实目录，由应用负责准备。本包不创建或清理目录；同进程同世界或同地图根不能重复打开。`maxDocumentBytes` 默认 1 MiB，`maxDocuments` 默认 10000，调用方可配置为正安全整数。读取过大文件由文件后端返回 `FS_TOO_LARGE`，扫描地点或连通目录超出数量限制返回 `MAP_LIMIT`。

存储提供世界概览、地点和连通文件的创建与按 ID 读取，以及按文件版本覆盖已有连通；地点 ID 和连通 ID 由程序生成。创建使用 `createIfAbsent`，连通更新使用从实际读取中核对的 `replaceIfVersion`；旧版本或目标已存在返回 `MAP_CONFLICT`。连通写入即为当前设定，地点与地图概览创建为建议。读取地点或连通、创建地点或连通时扫描并校验已记录地点图，拒绝未知层面、父级缺失、父级没有概况、跨层面引用及循环；损坏资料不会作为空结果跳过。扫描不会提供跨文件快照，坐标框的实际区域包含、面积、父子换算和查询工具尚未实现。

文件发布结果无法确定时抛出 `MAP_COMMIT_UNKNOWN`，携带地图根内相对路径供可信调用方核查；取消在后端确认未发布时保留 `FS_ABORTED`，不将其他失败一概视作回滚。读取拒绝符号链接和越出地图根的目标，但本机并发替换、硬链接和其他进程写入不由这些检查防护。调用方必须确保单可信写入进程、保护目录并按需要另行装配沙箱；`access: 'read-only'` 不替代操作系统权限。存储串行处理已受理的操作；`close()` 拒绝新操作、等待已受理操作并释放进程内占用，不关闭由调用方拥有的文件后端。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/map typecheck
pnpm --filter @fly-novel/map build
```
