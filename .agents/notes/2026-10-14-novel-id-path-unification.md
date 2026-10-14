# 小说 ID 与产物路径统一

## 决定

小说级与章节级工作流统一使用 `novelId`。工作区写入 `.fly-novel-store/<novelId>/workspace_node/`，章节草稿、断点和运行时状态写入 `.fly-novel-store/<novelId>/chapter_workflow/`。角色会话数据库写入 `.fly-novel-store/<novelId>/character_agent/main/session.sqlite`。

角色档案仍从 `.fly-novel/novel_data/<novelId>/character_agent/main/<characterId>/profile.md` 读取，因为它是配置输入；旧会话数据库首次创建新会话时复制到统一产物目录，保留旧文件。

## 影响

移除 `BookId` 品牌类型、工作流字段和 `--book` 参数。章节 JSON 文件直接以章节号命名，并校验记录中的 `novelId`，避免不同小说误用同一存储目录。已有嵌套工作区复制到直接工作区路径，旧目录保留作为备份。

## 验证

运行 `pnpm run typecheck` 与 `pnpm run build`；不运行测试。
