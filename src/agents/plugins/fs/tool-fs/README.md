# @fly-novel/tool-fs

文件工具包正在按[详细计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-tool-fs-plan.md)接入。`resolveReadTarget` 在读取前使用可信工作目录和文件后端的规范目标检查读取范围；它不读取文件、不发出观察事件，也不提供修改授权。检查后到读取之间的外部路径替换不受内核隔离保护。

上游来源为用户提供的 DeepSeek Harness 官方下载快照 `packages/fs/tool-fs`，版本 `0.2.2-rc.1`，没有已核验提交标识；许可证见 [LICENSE](LICENSE)。实际移植文件的哈希和调整随接入步骤记录，更新时重新核对源码、许可证和测试。

读取窗口与格式化代码移植自 `src/read-render.ts`，SHA-256 为 `72bcf4a70fd3e0908d4aa3869e0fbd6ee63b05ad790af65951af0c5db9edba84`；本地仅保留窗口及文本格式化部分，文件错误导入改为项目包，语言提示与展示元数据暂不接入。
