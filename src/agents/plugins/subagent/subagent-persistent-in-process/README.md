# @fly-novel/subagent-persistent-in-process

本包注册名为 `persistent` 的进程内 SubAgent Provider，复用现有运行驱动执行、取消和释放。它与 `spawn`、`fork` 并列；不复制父会话，不自行保存或恢复 Session。可信应用绑定 Preset、身份、Session 及资源，并在创建函数中显式装配持久化后端。

`createPersistentAgentCreator` 将一个可信身份绑定到创建回调，首次按配置选择 `create` 或 `resume`，成功启动后使用 `resume`；同一创建函数从启动到释放保持独占。调用方负责管理跨创建函数、跨进程的身份与资源互斥。模型不能通过请求参数指定身份、Session 或目录；Provider 不接受 `parameters`。

需要让同一个 Provider 服务多个持续身份时，可信应用使用 `createPersistentAgentRouter` 将固定绑定名映射到各自的创建函数；专用工具由可信装配固定其绑定名，模型不能借由业务参数授予身份。每个绑定名应与其创建函数配置的 `presetId` 一致；创建函数可以调用对应身份的应用入口。

启动失败由创建方负责回滚；若创建方使用 `AggregateError` 报告回滚失败，创建函数保持占用。运行句柄交付后由调用方等待结果和释放；释放失败时仍保持占用。取消和晚到句柄的清理由共享驱动负责。Session 存储位置、持久化格式及记忆能力由应用和 Session 后端确定，本包不声明长期记忆恢复。

父 Agent 的 Preset 装配 `subagent` 和 `subagent-persistent-in-process`，后者通过可信配置的 `create` 接收 `createPersistentAgentCreator` 返回值；运行时使用 `subagents.start('persistent', { parent, presetId, prompt, signal })`。完整装配和连续委派示例见[角色创建集成测试](../../../../app/tests/persistent-character-creator.test.ts)；该测试中的角色创建入口使用实际 JSONL Session 后端。
