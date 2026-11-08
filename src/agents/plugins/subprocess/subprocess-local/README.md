# @fly-novel/subprocess-local

显式注册的本机前台子进程提供方，使用 argv 直接启动并限制 stdout 和 stderr 的内存尾部。作用域关闭时终止仍归属的进程并等待提供方可观察范围退出；调用方负责期限信号及搜索路径授权。

本实现参考用户提供的 DeepSeek Harness 官方下载快照 `packages/subprocess/subprocess-local`，版本 `0.2.2-rc.1`，快照无已核验提交标识，许可证见 [LICENSE](LICENSE)。参考 `src/spawn.ts` 的 SHA-256 为 `1087f9ed1704167865e1a35cea0604f335cc348ac17da9c83c542fc454d00ae0`，`src/output.ts` 为 `1151a91d7bc31ffcd6ea3db85af2ef8c19ac4bc2d3a41654da9feac29cae7433`；本地适配搜索所需的忽略 stdin、限长收集、取消和回退进程管理，不包含终端、spill、Windows Job 或 Linux systemd scope。

POSIX 以进程组为管理范围，无法控制脱离该组的后代；Windows 使用 `taskkill /T /F` 尝试结束当前可观察进程树，等待时只能确认直接进程退出，无法保证已脱离父子关系的后代退出。它不是安全沙箱；仅可信代码可以选择可执行程序。平台限制和测试范围见[开发计划](../../../../../docs/workflows/word-initialization/world-initialization-stage-4-subprocess-plan.md)。
