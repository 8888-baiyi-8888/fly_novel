# 场景设置的归属与顺序

可直接演绎的故事需要可单独重读的场景设置。调用方提供故事内顺序、处境和导演准备信息，程序用运行 ID、故事 ID 和顺序组成场景身份。一个独占创建的设置文件同时占用身份和顺序，避免两个文件分别写入造成的失配。设置是新增的版本 1 记录，既有故事与模拟文件无需迁移。

场景读取核对故事归属及记录身份。DeepSeek Harness 按 Session 保存交互事件并通过只读句柄读取。这里按业务故事和场景身份读取设置，配置区分适用范围以 [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md) 中的 Session 记录定义为准。

聚焦测试从固定导演决定进入曲水城设置，验证重开存储、跨运行及故事拒绝、并发顺序冲突和重复身份拒绝。
