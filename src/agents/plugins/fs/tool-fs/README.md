# @fly-novel/tool-fs

文件工具包正在按[详细计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-tool-fs-plan.md)接入。`resolveReadTarget` 在读取前使用可信工作目录和文件后端的规范目标检查读取范围；它不读取文件、不发出观察事件，也不提供修改授权。`toolFsReadPlugin` 显式注册 `read`，以流方式读取和限制输出；读取前后版本不一致时拒绝并不记录观察。该检查不保证系统级原子快照，检查后到读取之间的外部路径替换不受内核隔离保护。

上游来源为用户提供的 DeepSeek Harness 官方下载快照 `packages/fs/tool-fs`，版本 `0.2.2-rc.1`，没有已核验提交标识；许可证见 [LICENSE](LICENSE)。实际移植文件的哈希和调整随接入步骤记录，更新时重新核对源码、许可证和测试。

读取窗口与格式化代码移植自 `src/read-render.ts`，SHA-256 为 `72bcf4a70fd3e0908d4aa3869e0fbd6ee63b05ad790af65951af0c5db9edba84`；本地仅保留窗口及文本格式化部分，文件错误导入改为项目包，语言提示与展示元数据暂不接入。

读取执行参考 `src/read.ts`（SHA-256 `a7f2c77f6bfaab1c8cba3aaf2fe187ba9c4ad75af905b54a6465a66760d1ab84`）及 `src/read-target.ts`（SHA-256 `3e89ce59dae8d4d568ed0833d4c939ac9cd62eda380e1b4addf697a311b56d43`）；本地改为项目工具契约、可信读取范围、始终流式读取和读取前后版本检查。读取配置使用固定上游默认上限，暂不提供展示卡片或提示词注册。

`toolFsMutationPlugin` 显式注册 `write` 和 `edit`，要求当前文件后端为 `SandboxedFileSystem`；这是本项目的受控装配要求，不表示上游工具依赖沙箱。编辑读取已有内容，先验证读取范围；写入结果不返回被覆盖的旧内容。工具按事件意图传递版本保护，成功后记录新版本；观察监听器在磁盘提交之后报错时，调用失败不表示修改已回滚。

写入和编辑参考上游 `src/write.ts`（SHA-256 `912db08eed1ea972a0a22fcded8428f6abde96fb588fd3f32529f4b5526ad6a8`）和 `src/edit.ts`（SHA-256 `276175218582695aa991cc8d044dd39f0aee667b90ac0f15964185865fc3211f`），本地调整输出与注册契约，不接入展示卡片或调用级沙箱提权。
