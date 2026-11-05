# @fly-novel/fs-patch

纯补丁解析与文本修改工作区包，不访问文件系统。`parsePatch` 解析补丁；`applyHunks` 接受 LF 文本并返回修改结果或匹配失败。调用方负责路径授权、文件操作和换行格式转换。

源码 `index.ts`、`parse.ts`、`apply.ts` 和 `types.ts` 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/fs/fs-patch)，固定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本地将源码从 `src/` 移至包根目录，使用本项目 CommonJS 和 TypeScript 构建配置；源码内容未修改。完整许可证见 [LICENSE](LICENSE)，其中包含 DeepSeek 的 MIT 条款和 OpenAI Codex 来源的 Apache-2.0 条款。

更新时对照固定上游目录同步源码，检查许可证和依赖变更，重新应用目录及构建配置调整，运行本包类型检查、构建及相关补丁测试。
