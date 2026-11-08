# @fly-novel/fs-sandbox

显式装配的本机文件修改后端，依赖当前 Agent 的 `sandboxPolicy`，代替而非同时注册 `fs-local`。默认只读；工作区写入模式根据可信策略和上游可写根检查写、编辑、补丁、删除与移动两端。读取、列举与搜索授权不由本包提供。仅提供应用层路径检查，检查后到系统调用前仍存在路径替换竞争；生产装配前须重新评估，不能视为内核沙箱或跨进程事务。

源码依据用户提供的 DeepSeek Harness 官方 `packages/fs/fs-sandbox` 下载快照 `0.2.2-rc.1`，无已核验提交，源文件哈希见[开发计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-fs-sandbox-plan.md#第-1-步核对记录)。使用 [MIT 许可证](LICENSE)。本地改用项目文件契约、本机后端和固定 Agent 策略，不接收每次调用的模式覆盖，不暴露上游 `sandboxMode`；保留上游目标重新解析及包含检查。更新时核对官方源码、许可证、依赖和本地适配，并运行包与路径边界测试。
