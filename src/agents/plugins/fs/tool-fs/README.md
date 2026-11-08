# @fly-novel/tool-fs

可信装配可以注册 `toolFsPluginDefinition`：默认提供 `read`、`write` 和 `edit`，只有配置 `applyPatch: true` 才注册 `apply_patch`。修改工具要求沙箱后端；Agent 作用域销毁时工具随之注销。

文件工具包正在按[详细计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-tool-fs-plan.md)接入。`resolveReadTarget` 在读取前使用可信工作目录和文件后端的规范目标检查读取范围；它不读取文件、不发出观察事件，也不提供修改授权。`toolFsReadPlugin` 显式注册 `read`，以流方式读取和限制输出；读取前后版本不一致时拒绝并不记录观察。该检查不保证系统级原子快照，检查后到读取之间的外部路径替换不受内核隔离保护。

上游来源为用户提供的 DeepSeek Harness 官方下载快照 `packages/fs/tool-fs`，版本 `0.2.2-rc.1`，没有已核验提交标识；许可证见 [LICENSE](LICENSE)。实际移植文件的哈希和调整随接入步骤记录，更新时重新核对源码、许可证和测试。

读取窗口与格式化代码移植自 `src/read-render.ts`，SHA-256 为 `72bcf4a70fd3e0908d4aa3869e0fbd6ee63b05ad790af65951af0c5db9edba84`；本地仅保留窗口及文本格式化部分，文件错误导入改为项目包，语言提示与展示元数据暂不接入。

读取执行参考 `src/read.ts`（SHA-256 `a7f2c77f6bfaab1c8cba3aaf2fe187ba9c4ad75af905b54a6465a66760d1ab84`）及 `src/read-target.ts`（SHA-256 `3e89ce59dae8d4d568ed0833d4c939ac9cd62eda380e1b4addf697a311b56d43`）；本地改为项目工具契约、可信读取范围、始终流式读取和读取前后版本检查。读取配置使用固定上游默认上限，暂不提供展示卡片或提示词注册。

`toolFsMutationPlugin` 显式注册 `write` 和 `edit`，要求当前文件后端为 `SandboxedFileSystem`；这是本项目的受控装配要求，不表示上游工具依赖沙箱。编辑读取已有内容，先验证读取范围；写入结果不返回被覆盖的旧内容。工具按事件意图传递版本保护，成功后记录新版本；观察监听器在磁盘提交之后报错时，调用失败不表示修改已回滚。

写入和编辑参考上游 `src/write.ts`（SHA-256 `912db08eed1ea972a0a22fcded8428f6abde96fb588fd3f32529f4b5526ad6a8`）和 `src/edit.ts`（SHA-256 `276175218582695aa991cc8d044dd39f0aee667b90ac0f15964185865fc3211f`），本地调整输出与注册契约，不接入展示卡片或调用级沙箱提权。

`toolFsPatchPlugin` 显式注册 `apply_patch`，要求沙箱后端；解析及预检完成后按顺序提交，失败停止后续操作，不回滚已完成修改。模型结果报告每项状态和已修改路径，不返回文件旧内容；取消后保留部分报告。补丁预检的所有目标须通过读取范围检查，内部读取不记录观察。监听器在提交后失败时报告已修改路径；操作启动后无法确定结果时报告 unknown。

补丁规划、预检、执行及类型适配自上游 `src/patch/`，原始 SHA-256：`index.ts` `fd4f9a3f021764dbf6209e19e783dd528072051c0809570275205411bb9d1171`、`plan.ts` `0fd46d5589092b3346183623da9204c99f9912f6abba25aaace6a197cc601389`、`preflight.ts` `faf8f64ef48afa26476ee6952fdf458eb8801998489689ec8d8e71282da00fe2`、`execute.ts` `a49c07be5ff7c5a92593a8d4f0b16019eaa50b65c4e70ce632eeb53914b4479a`、`types.ts` `144965d2f42ee4df79f0ed80be39e622f129f3a0f231dc03bfd171f899c3f5ba`。本地改用项目文件、工具与补丁契约，增加读取授权和已提交结果保留，不接收上游逐调用模式覆盖或展示元数据。
