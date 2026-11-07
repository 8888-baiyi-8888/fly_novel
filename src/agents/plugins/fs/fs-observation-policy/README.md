# @fly-novel/fs-observation-policy

显式装配的文件观察策略插件，不注册文件服务或模型工具，也不提供路径授权或沙箱。`fsObservationPolicyPluginDefinition` 可通过 Harness 插件注册表注册，再由受信任的 Preset 选择；插件依赖本 Agent 的 `tools` 和 `sessions`，不依赖 `fs-local`。导入包不注册监听器，生产 Preset 未选择此插件。

文件工具须以自己的 `ToolRunContext` 为 actor 发出 `fs/observed` 和对应的 intent，并把返回保护交给后端。策略按 ToolsService 的稳定 Agent 身份匹配共享事件总线；其他身份调用 `next()`。同一 Agent 重复装配会失败，监听器和状态由插件作用域释放。Session 关闭时删除观察；非本 Agent 或关闭中的 Session 会报错。独立调用无 Session 时不记录观察，写入得到创建保护，编辑及删除报告 `FS_NOT_OBSERVED`。注册在策略之前的其他决策监听器仍可短路；直接调用后端也能绕过策略。

存在观察产生版本保护，未观察或确认缺失的写入产生创建保护；编辑及删除对缺失观察返回 `FS_NOT_FOUND`。后端负责实际检查及文件操作，观察不会持久化，恢复和 Fork 使用新 Session。观察事件同步执行，监听器异常可在文件操作提交后传播。

源码行为基于用户提供的 DeepSeek Harness `packages/fs/fs-observation-policy` 官方下载快照 `0.2.2-rc.1`，没有已核验的提交标识；源码哈希和发布清单比较见[开发计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-fs-observation-policy-plan.md#第-1-步核对结论)。使用 [MIT 许可证](LICENSE)。本地将导入改为项目包，改为从工具执行上下文取得 Session，增加 Agent 身份路由、Session 归属与关闭检查、重复装配检查和显式 Harness 定义。更新时重新核对官方源码和许可证，重新应用这些适配并验证受影响行为。
