# 子 Agent 运行清理与 Manager 整体关闭

## 问题

父 Agent 关闭时可能等待 Driver 释放子 Agent；如果同一 Manager 的单实例清理等待整个 disposeAll，整体关闭也等待父 Agent，就会形成循环等待。Driver 的取消入口失败也不能阻止资源释放或遮盖清理错误。

## 决定

Manager 按 Agent ID 共享正在进行的清理，整体关闭期间仍允许清理其他实例，并等待既有清理；清理完成前保留 ID 占用。Driver 的重复释放共享一次 Promise，等待任务与创建方清理，分别保留结果错误和清理错误；取消入口和释放同时失败时汇总报告。

## 影响与验证

整体关闭继续按逆登记顺序开始清理，但父 Agent 的清理可提前触发子 Agent 的清理。真实 Manager 和固定模型替身测试覆盖父 Agent 经 Driver 释放子 Agent、并发清理和 ID 占用；模拟 Agent 测试覆盖监听器、独立取消和错误传播。真实 Provider 创建链路留待后续集成。
