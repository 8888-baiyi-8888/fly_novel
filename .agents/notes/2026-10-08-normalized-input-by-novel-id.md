# 整理输入按小说 ID 保存

问题：小说级 LangGraph 原先从全局 `artifacts/n0-raw-input/` 读取最新文件，运行新小说时可能复用另一部小说的整理输入。

决定：应用入口将产物根目录传给小说图；整理输入产物读写函数将根目录绑定为参数，并以 `novelId` 为唯一查找范围，目录为 `{artifactRoot}/{novelId}/normalized_input/`。读取同时返回文件路径和内容。`novelId` 必须是单个安全路径段。草案单步运行要求显式传入 `--novel-id`。

影响：旧建书入口 `src/app/main.ts` 及其 N0 路径保持原样，留待后续处理。旧版 `artifacts/n0-raw-input/` 不自动迁移，也不被小说级 LangGraph 读取；已有文件保留。其余建书节点仍使用原有全局产物目录，尚未按小说 ID 隔离。

验证：`pnpm run typecheck` 与 `git diff --check`。
