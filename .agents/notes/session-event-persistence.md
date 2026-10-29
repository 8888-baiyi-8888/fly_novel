# Session 事件持久化与恢复

问题：内存 Session 的同步事件无法自动进入异步持久化后端，已保存事件也不能重建 Surface。

决定：Session Manager 通过 Cordis 发布事件及刷新、关闭通知，JSONL 后端按写句柄顺序缓存并写入，失败后保留待写事件；调用方可将已读取事件作为种子创建 Session 并重建消息视图。关闭 Session 时禁止新事件并等待刷新。

影响：Session Manager 的 close 和 closeAll 改为异步；Agent Loop 尚未自动选择持久化会话，中断 Turn 的恢复留待后续步骤。

验证：Session 持久化恢复、失败重试、关闭、Harness 和工具调用聚焦测试及构建通过。
