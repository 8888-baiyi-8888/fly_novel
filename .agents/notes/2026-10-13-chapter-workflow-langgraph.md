# 章节流改用 LangGraph 编排

问题：章节工作流由自研 `ChapterWorkflow` 控制顺序、重试和断点续跑，需统一使用 LangGraph 编排。

决定：保留七个节点工厂及其 Agent 调用、解析、闸门、结算行为；新增章节 StateGraph，由节点状态和条件边控制顺序、回退与重试预算。`run-chapters.ts` 改用 LangGraph 入口。节点产物仍存于 `artifacts`，并继续使用 `WorkflowStore` 的 JSON 格式，在每次状态转移后保存，以维持已有章节数据的恢复能力。

影响：`simulate` 仍一次生成全部角色模拟；`BookRuntime` 和跨章运行时状态文件保持原用法。旧 `ChapterWorkflow` 暂留供兼容调用与既有测试。验证应覆盖完整七步、direct 闸门重试、audit/censor 回写重试、超预算挂起及已保存状态恢复。
