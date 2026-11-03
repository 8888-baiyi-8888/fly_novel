# SubAgent 一次性委派契约

## 问题

SubAgent 核心包需要描述父 Agent 和一次运行，而 Agent 包后续会装配核心服务；双向包依赖会形成循环。

## 决定

核心包接收现有 Agent 可满足的最小身份视图，定义 Provider、任务请求、运行标识、结果和清理契约。Provider 在发布前负责清理，发布后由句柄持有方处理结果和释放。运行标识由 Provider 在父 Agent 范围内分配并与 Agent ID 区分。

## 影响与验证

核心包不依赖 Agent 包，不提供服务注册或真实 Provider。根类型检查验证现有 Agent 可用于请求；模拟 Provider 测试验证公开契约的基本使用。后续驱动若需要父 Agent 更多能力，应重新评估无环契约，不引用其他包的内部文件。
