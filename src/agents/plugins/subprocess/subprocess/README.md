# @fly-novel/subprocess

搜索所需的前台子进程服务契约，不会在导入时启动进程。提供方负责显式注册、管理范围终止和作用域清理；调用方提供可信程序路径、参数、工作目录、输出上限、宽限期和取消信号。契约区分直接进程结果与提供方可观察范围退出，具体限制由提供方说明。

适配用户提供的 DeepSeek Harness 官方下载快照 `packages/subprocess/subprocess`，版本 `0.2.2-rc.1`，快照无已核验提交标识；来源与哈希见[开发计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-subprocess-plan.md)，许可证见 [LICENSE](LICENSE)。本包仅保留搜索需要的普通进程与内存输出契约，不提供终端、spill、管道或代理环境叠加。
