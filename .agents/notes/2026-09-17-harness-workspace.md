# Harness 独立工作区包

决定：将 src/harness 登记为私有工作区包 @fly-novel/harness，独立声明对 LLM 和 util 的工作区依赖。根项目引用 Harness，源码检查映射到公共入口，正式构建由包配置输出到本包 dist。

范围：保留正在编写的 Agent 和会话实现；不安装外部 session-projection 等包，由用户后续选择版本并安装。公共入口导出现有 Agent 接口、SessionId 和提示词组装类型。

验证：检查工作区识别和构建配置。源码尚有未安装的外部依赖及未完成的 Agent 定义，不能将分包配置完成视为 Harness 已可构建或运行。
