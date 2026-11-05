# @fly-novel/subagent-fork-in-process

Fork 插件在父 Agent 作用域注册 `fork` Provider。启动时校验父身份、SubAgent 服务及标准 Agent Loop 归属，从 Loop 捕获已结束轮次的历史，再通过共享 Driver 和可信创建函数启动子 Agent。运行句柄交付后由调用方等待结果并释放。父作用域没有独立 SubAgent 服务或 Loop 时不能使用继承的根服务冒充。

可信应用通过 `createForkAgentCreator(framework, presets)` 提供允许的 Preset、模型和插件配置。`presetId` 必填；可选 `parameters` 通过现有创建链复制到子 Agent。子会话是独立内存 Session，不能指定持久化 ID。可信应用应确保所选插件不会自行恢复或共享会话。

首版只接受纯文本的已结束轮次，不接受工具调用、工具结果、非文本内容或私有重放状态；当前未结束轮次不继承。两个现有模型委派工具仍使用 Spawn；本包不提供可继续运行或后台通知。
