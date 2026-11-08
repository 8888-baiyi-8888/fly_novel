# @fly-novel/sandbox-policy

受信任的 Agent 装配提供不可变文件修改策略，缺省模式为 `read-only`。`workspace-write` 必须显式指定现有真实绝对目录；附加可写根需要可信装配显式提供。上游根计算还包含平台临时根，详见 [`@fly-novel/sandbox`](../sandbox/README.md)。该服务只提供策略，文件后端负责执行，不能将其视为授权或操作系统沙箱。

本包按用户提供的 DeepSeek Harness 官方下载快照 `packages/sandbox/sandbox-policy` 版本 `0.2.2-rc.1` 的模式和配置行为适配，快照无可核验提交。`src/index.ts` SHA-256 为 `de18aa0f8f2ab668876f9f181dd521b72910da428eab185fb85dd30163af8d35`，`src/session-mode.ts` 为 `afe650fc43e87031eb7b50d9a1717b926906e4fcaab01199cd434235586714d7`；使用 [MIT 许可证](LICENSE)。本地固定每个 Agent 的策略，不引入 Session 投影、提示词或调用级提权；缺少可写工作区时拒绝，而非回退进程目录。更新时核对来源、许可证和依赖，重新评估上述适配并运行策略与文件后端测试。
