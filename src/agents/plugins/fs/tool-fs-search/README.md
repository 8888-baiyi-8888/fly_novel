# @fly-novel/tool-fs-search

文件搜索包按[详细计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-tool-fs-search-plan.md)接入。固定使用 `@vscode/ripgrep`，通过可信读取根解析搜索目标，以参数数组直接执行；搜索与返回前检查之间存在外部路径替换窗口，不构成内核读取隔离。

可信应用显式注册 `toolFsSearchPluginDefinition` 并装配同一作用域的 `tools`、`fs` 和 `subprocess`。`glob` 搜索隐藏及忽略文件并排除常见版本控制目录，`grep` 使用 ripgrep 默认忽略规则；二者不启用目录符号链接跟随，结果路径和匹配内容返回前逐项校验读取根。输出数量、行预览、原始输出、错误输出、超时和终止宽限期可通过插件配置；截断时提示缩小范围，不保存完整结果。

`grep` 对 ripgrep 返回的非 UTF-8 行显示 `[bytes]`，不解码为正文；行预览限制小于该标记时仍会截断标记。

参考用户提供的 DeepSeek Harness 官方下载快照 `packages/fs/tool-fs-search`，版本 `0.2.2-rc.1`，无已核验提交标识；来源及原始哈希见详细计划，许可证见 [LICENSE](LICENSE)。
