# @fly-novel/tool-fs-search

文件搜索包按[详细计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-tool-fs-search-plan.md)接入。固定使用 `@vscode/ripgrep`，通过可信读取根解析搜索目标，以参数数组直接执行；搜索与返回前检查之间存在外部路径替换窗口，不构成内核读取隔离。

参考用户提供的 DeepSeek Harness 官方下载快照 `packages/fs/tool-fs-search`，版本 `0.2.2-rc.1`，无已核验提交标识；来源及原始哈希见详细计划，许可证见 [LICENSE](LICENSE)。
