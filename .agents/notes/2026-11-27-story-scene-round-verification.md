# 曲水城场景与整轮读取验证

整轮固定替身用例将版本化场景回报接入已有的三批推进，沿应用入口核对计划、父子故事、两份模拟记录、暂停和整轮结算。可信模拟器从当前调用直接取得运行 ID 和故事 ID，场景结果提交仍由当前故事绑定的回调校验。已有存储格式和无场景的调用路径保持兼容。

DeepSeek Harness 从 Session 读取交互事件，本用例通过故事业务文件重读场景和结算证据。两者均有只读查询入口，故事进度由运行记录解释。见 [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md)。
