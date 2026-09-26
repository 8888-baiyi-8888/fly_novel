# CharacterAgent 输出结构由调用方定义

日期：2026-09-24

问题：角色类内置 performance、innerActivity、stateChanges 等字段，限制了调用方按本轮任务定义输出结构。

决定：移除内置字段枚举、预设 Schema 文件和 outputRequirements，run 接收调用方提供的 responseFormat Zod 对象。每轮 Schema 通过中间件传给框架，复用既有 Agent 和记忆。返回类型根据外部 Schema 推导，业务字段只出现在调用样例和文档中。

适配：先调用 z.toJSONSchema，再交给 toolStrategy。已安装 SDK 直接转换 Zod 时会将 looseObject 的 additionalProperties 强制设为 false，显式转换可保留调用方的规则。框架校验 JSON Schema 后，返回边界使用原 Schema 解析。缺失或无效 Schema 在模型初始化前失败。

影响：调用接口变为 run({ scene, responseFormat })，删除 CharacterOutputField、CharacterOutputRequirements、CharacterAgentOutput。应用样例直接声明 Zod 依赖，演示两轮不同字段。文件记忆和会话边界保持不变。

验证：18 项聚焦测试通过，覆盖自定义嵌套输出、可选项和 TypeScript 返回类型推导、动态切换 Schema、无标题 Schema、额外字段拒绝与保留、无效输入、旧结果隔离及原有记忆与并发行为。未调用真实供应商。
