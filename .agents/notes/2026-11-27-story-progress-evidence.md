# 按业务证据核查故事进度

只读查询从根故事沿已保存的安排向下核查回报及其场景证据，然后与最新暂停的位置比对。已消费的历史暂停在未取得新的有效位置时只供核查。正常继续在核对相同的推进证据后沿用独占消费标记。无需新增进度文件或迁移旧记录。

DeepSeek Harness 在 [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md) 中区分只读观察与写入所有权，并由读取方解释未完成的交互。本项目的核查同样不占用写入权，完成判定由故事及场景记录提供。

固定替身覆盖两场景只计一个子故事、结算后代证据缺失、设置后中断、回报失败、消费后失败及整轮完成。
