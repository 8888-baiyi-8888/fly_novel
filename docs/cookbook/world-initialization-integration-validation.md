# 世界初始化跨模块整合验证

本指南验证世界初始化主子 Agent 的跨模块装配和第一版总览。运行环境、Node.js 和 pnpm 要求见[项目入口](../../README.md)；真实模型需要本机有效的模型配置和网络，见[配置说明](../../src/config/README.md)。

## 双世界固定替身

在仓库根目录执行：

```powershell
pnpm run build:tests
node --test .test-dist/app/tests/world-modules-integration.test.js
```

测试在独立临时世界中使用真实 Agent、工作区、目录、Session 和文件，模型使用预设替身。修仙世界覆盖八类专用 Agent 与十个内容模块；城邦世界保留未委派的专有内容，并验证两个候选局势分别关联自己的发展方向。主 Agent 读取实际成果后保存待审总览。该测试验证执行路径和数据关系，不证明真实模型会正确规划、判断完整或遵循指引。

## 真实模型样例

测试使用隔离目录，不读取或修改已有世界；成功和失败时保留测试目录，以测试输出中的路径为准。启用真实模型后，在同一终端执行：

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST = '1'
node --test .test-dist/app/tests/world-integration-real.test.js
```

样例要求主 Agent 协调地图和组织 Agent，核查实际地点关联并保存待审总览，然后恢复同一主会话读取已有成果。每次真实模型运行可能生成不同内容或失败；样例只覆盖地图、组织和总览，不代表十个模块的真实模型质量。需要人工检查总览、来源、留白及未覆盖范围。

如果调用中断或超时，先核查输出的隔离目录及已保存 Session、地图、组织、目录和总览。确认使用原目录恢复时，在同一终端设置以下变量再运行上述测试；模型收到“继续”后仍需核查实际成果，不能根据历史回复假设任务完成。

```powershell
$env:FLY_NOVEL_INTEGRATION_REAL_RESUME_ROOT = '<上次输出的隔离测试目录>'
node --test .test-dist/app/tests/world-integration-real.test.js
```

测试结束后在当前终端移除 `FLY_NOVEL_REAL_LLM_TEST` 和 `FLY_NOVEL_INTEGRATION_REAL_RESUME_ROOT`，防止后续测试意外调用真实模型或复用该目录。不要删除仍需核查或恢复的成果。
