# 父子故事只读查询

场景需要归属可核查的业务故事。应用层通过 `readStory` 打开既有存储，沿根故事、上级安排和推进决定核对归属，再从拆分和补充记录返回直接子项。缺少回报证据的子项保持未结算，身份冲突拒绝读取。查询无需装配导演，不占用暂停批次，文件格式沿用版本 1。

与 DeepSeek Harness 的只读 Session 句柄相同，查询不获取写入所有权。Session 按交互事件组织，本项目按规划和故事 ID 查询业务节点及回报。见 [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md)。

聚焦测试通过应用入口重读曲水城三层故事，并检查跨规划、父身份失配、缺失节点和缺失模拟证据。
