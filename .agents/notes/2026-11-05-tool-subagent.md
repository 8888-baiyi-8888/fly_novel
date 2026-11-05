# 通用子 Agent 前台委派工具

## 问题

父 Agent 的模型需要通过工具使用既有 Spawn 创建通用子 Agent，并将子任务结果交回父会话。

## 决定

新增独立 tool-subagent 工作区包，以作用域插件注册 delegate；工具内部选择 spawn 和 generic-subagent，前台等待结果并释放 Run。角色专用工具不属于该包。

## 影响与验证

父 Agent 显式装配工具和 Spawn，可信调用方提供子 Agent 模型配置。固定模型测试验证真实 Loop、Spawn、结果、隔离、错误和取消；后台通知与真实模型行为不在本步范围。
