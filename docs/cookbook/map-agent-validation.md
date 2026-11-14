# 验证地图 Agent

本指南验证地图 Agent 的文件工具与世界初始化委派。固定模型替身用于可重复检查执行路径；真实模型检查使用本机供应商配置，产生实际请求和费用，模型输出需要人工审阅。

在仓库根目录编译测试并运行双世界走查：

```powershell
pnpm run build:tests
node --test .test-dist/app/tests/map-agent-e2e.test.js .test-dist/app/tests/map-agent.test.js .test-dist/agents/tests/map-query.test.js .test-dist/agents/tests/map-store.test.js
```

双世界用例通过主 Agent 将修仙世界和城邦群分别委派给地图 Agent，检查同名地点、按 ID 读取、逐层坐标、连通创建与版本覆盖、留白、成果登记和跨世界读取拒绝。其他用例覆盖身份占用、会话恢复、取消、目录不可用、过期版本和写入结果不确定。替身的预设调用不证明真实模型会正确规划。

真实模型检查前按[配置说明](../../src/config/README.md)准备 DeepSeek 配置、加密凭据和密钥，确认网络可访问模型服务。在同一个 PowerShell 窗口执行：

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST='1'
node --test .test-dist/app/tests/map-agent-real.test.js
Remove-Item Env:FLY_NOVEL_REAL_LLM_TEST
```

测试在 `tmp/map-real-*` 下创建独立世界和 Session，并在测试输出中报告目录；结束后保留成果以供检查，不覆盖已有世界。检查确认世界地图保留外海留白、创建青河地区和曲水城并关联父级，并依据保存的矩形核对最终报告中的世界坐标。该测试不装配资料目录，不验证主 Agent 在真实模型下的委派，也不评判比例和地理内容是否合理。模型调用失败、超时或未满足断言时测试失败；检查对应目录内的已写入成果后再决定如何重试，不能假定文件未创建。
