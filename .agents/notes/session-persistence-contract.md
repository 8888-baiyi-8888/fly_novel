# Session 持久化契约

问题：内存 Session 不能跨进程恢复，存储能力需要独立于 Session 和 Loop。

决定：在 Agents 包中提供 `sessionPersistence` Cordis 服务及单会话句柄契约；当前以测试专用内存后端验证接口，暂不提供文件存储。接口参照 DeepSeek Harness，先适配现有事件及会话身份，格式版本与恢复接入留在后续步骤。

影响：现有 Session 和 Loop 行为不变；内存测试后端不提供持久性保证。

验证：测试编译、正式构建、持久化契约、Session 与 Harness 聚焦测试通过。
