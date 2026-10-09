# 小说级产物按小说和节点分目录

问题：N1～N7 仍从全局节点目录读取最新文件，单步续跑可能混用不同小说的产物；章节入口也依赖旧版全局书目录。

决定：小说级产物统一写入 `{artifactRoot}/{novelId}/{nodeName}/`，工作空间位于 `workspace_node/{bookId}/`。所有单步读取必须指定 `novelId`；章节入口可按 `--novel-id/--book` 定位，也可选最近修改的新格式书目录。章节正文、断点和运行时状态写入 `{store-dir}/{novelId}/chapter_workflow/{bookId}/`。

影响：旧版全局 N0～N7 产物不自动迁移，小说级新入口不读取；旧版章节数据保留，检测到同名书旧目录时拒绝从空状态续写。`src/app/main.ts` 保持原样。书目录内的 `ready.json` 保留作为章节交接凭据，`ready_node/` 另存节点产物。

验证：`pnpm run typecheck`、`pnpm run build`、`git diff --check`。
