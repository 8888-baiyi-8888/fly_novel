# 进程内子 Agent 创建契约

## 问题

共享 Driver 需要创建并释放子 Agent，同时 Agent 包已有子 Agent 核心插件；直接让 Driver 依赖 Agent 包会使后续 Provider 装配更容易形成依赖环。

## 决定

Driver 包只依赖 SubAgent 核心契约，由调用方注入创建函数。创建方成功时返回运行标识、Agent 的最小运行和取消能力，以及负责释放和移除登记的句柄；创建失败前负责回滚，交付后由 Driver 负责释放。创建方可通过闭包携带后续创建配置，不预先定义 Fork 历史格式。

## 影响与验证

Driver 契约不直接承诺 Manager、Session 或模型配置的具体实现。项目 Agent 和 Manager 的调用方适配通过类型检查；模拟创建方测试验证契约形状。真实执行、取消交接、清理和 Manager 生命周期交错待后续步骤验证。
