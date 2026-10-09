# 草案节点同时生成书籍配置

问题：书籍配置只从草案提取运行参数，却作为独立 LangGraph 节点和单步命令维护。

决定：`draft_node` 同时返回草案和 `BookConfig`；缓存草案时复用已有配置，缺少配置时从草案补建。移除 `book_config` 图节点和 `bc` 单步命令，保留领域函数 `buildBookConfig`。

影响：`story_foundation` 直接接在 `draft_node` 之后；草案和配置仍分别存入现有 `draft_node/` 与 `book_config/` 目录，不迁移或删除既有产物。单步 `dra` 输出两份产物。

验证：运行 TypeScript 类型检查并检查变更空白格式；未运行行为测试。
