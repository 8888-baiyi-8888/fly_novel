# @fly-novel/character-creator-system-prompt

角色设定创建 Agent 的 Cordis 提示词插件，依赖 `systemPrompt` 服务。可信应用必须提供正整数 `defaultCharacterCount`；用户指定数量时提示词要求优先遵循用户要求。资料目录工具已装配时，提示词指导 Agent 完整读取成果并使用读取凭据更新简介。插件随作用域注册和注销提示词，不提供角色资料工具、文件授权或用户确认能力。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/character-creator-system-prompt typecheck
pnpm --filter @fly-novel/character-creator-system-prompt build
```
