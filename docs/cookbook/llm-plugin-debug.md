# LLM 插件逐步调试

本文在 [Harness 测试入口](../../src/agents/tests/harness.test.ts)中检查 LLM 插件装配、路由隔离与清理，并按需运行真实模型用例。真实 Agent Loop 尚未接入此插件；`agent.run()` 仍由 mock loop 回显输入，真实用例直接调用 Agent 的 `llm.stream()`。

## 1. 编译调试入口

在仓库根目录运行：

```powershell
pnpm run build:tests
```

命令构建工作区包并将测试编译到 `.test-dist/`。编译成功后，确认 `.test-dist/agents/tests/harness.test.js` 存在。源码或测试改动后重新执行该命令；不要直接运行上次编译留下的文件。

## 2. 单独运行 LLM 装配测试

```powershell
node --test --test-name-pattern="LLM 插件由 Preset 选择" .test-dist/agents/tests/harness.test.js
```

预期结果是 `tests 1`、`pass 1`、`fail 0`。该测试在运行时注册 `llm-debug` Preset；它包含 `mock-loop` 和 `llm`，不会修改角色、导演的 mock Preset。

## 3. 在 VS Code 中下断点

打开“运行和调试”，选择本机现有的“调试 Cordis Agent Harness 测试（真实请求跳过）”，按 F5。该配置的 `preLaunchTask` 是“编译调试测试”，入口是 `.test-dist/agents/tests/harness.test.js`；默认运行此文件中的全部 Harness 测试，真实模型用例会跳过。要在 VS Code 中只执行第 2 步的用例，可在本机 `.vscode/launch.json` 的该配置中将 `runtimeArgs` 临时改为 `["--test", "--test-isolation=none", "--test-name-pattern=LLM 插件由 Preset 选择"]`；检查第 4、5 步时换成对应命令中的测试名称。随后在下面位置下断点：

1. [测试入口](../../src/agents/tests/harness.test.ts)中“LLM 插件由 Preset 选择”用例的 `framework.presets.register(...)`：观察 `framework.plugins.list()` 含 `llm`，以及角色、导演的 mock Preset 未声明 `llm`。
2. [Agent 工厂](../../src/agents/runtime/agent-factory.ts)中解析 `preset.plugins` 的位置：观察本次 `llm-debug` Preset 选中 `llm`，以及 `options.pluginConfigs.llm` 分别包含 `first`、`second` 路由。
3. [LLM 插件](../../src/agents/plugins/llm/index.ts)中 `new LlmRuntime(ctx)` 和 `ctx.effect(...)`：观察每个 Agent 创建自己的服务，并注册对应适配器。
4. [LLM 运行时](../../src/llm/runtime.ts)中 `registerAdapter(...)` 和 `stream(...)`：观察 `first`、`second` 请求各自命中适配器；在第一个 Agent 的服务中请求 `second` 应返回 `NO_ADAPTER` 结束块。
5. 返回测试用例的 `manager.dispose('first')`：单步进入 [Agent 实例](../../src/agents/core/agent.ts)的 `dispose()`；清理后 `first.context.get('llm')` 为 `undefined`，保存的 `firstLlm` 再请求 `first` 返回 `NO_ADAPTER`，`second` 仍能成功。

VS Code 的“继续”跳到下一个断点，“单步跳入”进入当前函数；如果进入 Cordis 依赖源码，可用“单步跳出”回到项目代码。测试中的 `assert` 失败时，终端会显示失败用例和断言位置。

## 4. 单独检查配置失败与清理

```powershell
node --test --test-name-pattern="LLM 插件拒绝空配置" .test-dist/agents/tests/harness.test.js
```

预期结果同样是 `tests 1`、`pass 1`、`fail 0`。在[失败路径用例](../../src/agents/tests/harness.test.ts)的两次 `manager.create(...)`、[LLM 插件](../../src/agents/plugins/llm/index.ts)的配置检查和路由注册、[Agent 实例](../../src/agents/core/agent.ts)的异常清理处下断点：空 `adapters` 被拒绝；第二条路由的适配器元数据错误使创建失败；`manager.list()` 为空，同一 ID 随后可用有效配置创建。要观察第一条路由的注销，可在 [LLM 运行时](../../src/llm/runtime.ts)的 `registerAdapter()` 返回的清理函数中下断点，跟进失败后的作用域销毁。

## 5. 检查原有 mock Preset

```powershell
node --test --test-name-pattern="通过外部注册的 Preset" .test-dist/agents/tests/harness.test.js
```

预期结果仍是 `tests 1`、`pass 1`、`fail 0`。测试会检查插件注册表包含 `llm`，而角色、导演 Agent 的 `context.get('llm')` 均为 `undefined`；两者的 `agent.run()` 继续返回各自 mock loop 的文本。

## 6. 运行整个 Harness 测试文件

```powershell
node --test .test-dist/agents/tests/harness.test.js
```

此命令运行 Harness 测试文件，真实模型用例会被跳过。若想重新验证刚修改的源码，先执行第 1 步编译，再运行本步。

## 7. 准备真实模型配置

按[配置模块说明](../../src/config/README.md)准备本机 `.fly-novel/settings.json`、`.credentials.json` 和 `.encryption-key`，其中需要有效的 `deepseek` 配置。真实用例通过 [适配器工厂](../../src/app/llm-adapters.ts)加载该 provider 的 model、baseURL 和加密凭据，产生实际 API 调用。

## 8. 从命令行发起真实请求

先按第 1 步构建测试，再在仓库根目录运行：

```powershell
$env:FLY_NOVEL_REAL_LLM_TEST = '1'
node --test --test-name-pattern="LLM 插件调用真实模型" .test-dist/agents/tests/harness.test.js
Remove-Item Env:\FLY_NOVEL_REAL_LLM_TEST
```

`FLY_NOVEL_REAL_LLM_TEST=1` 明确启用此用例；普通 Harness 测试会显示它被跳过。预期结果是 `tests 1`、`pass 1`、`fail 0`，终端还会显示 `LLM 插件真实响应：` 和非空模型文本。模型措辞可能略有差异。请求失败时测试失败，请检查本机配置、凭据和网络。

## 9. 在 VS Code 中跟踪真实请求

在“运行和调试”中选择“调试 LLM 插件真实请求测试（DeepSeek）”，按 F5。本机启动配置会执行“编译调试测试”，设置用例启用变量，并只运行真实请求用例。两条 Harness 调试配置都使用 `--test-isolation=none`，使 Node 24 测试运行器在当前进程执行用例，便于命中源码断点。建议依次设置断点：

1. [Harness 测试入口](../../src/agents/tests/harness.test.ts)中“LLM 插件调用真实模型”用例的 `loadConfiguredAdapter(...)`：观察 provider 和 model；不要在调试日志中输出解密后的凭据。
2. [配置读取](../../src/app/call-llm.ts)的 `readSettings()`、`decryptSecret(...)` 和 `createAdapter(...)`：确认从本机配置选择适配器。
3. [Agent 工厂](../../src/agents/runtime/agent-factory.ts)处理 `preset.plugins` 的位置及 [LLM 插件](../../src/agents/plugins/llm/index.ts)的 `ctx.effect(...)`：确认 `llm-real` Preset 选择插件，路由注册在本次 Agent 的作用域。
4. 用例的 `llm.stream(...)`，以及 [DeepSeek 适配器](../../src/llm/adapters/deepseek.ts)的请求位置：继续执行后观察模型返回的 `block-end` 文本和 `finish` 原因。
5. 用例结束后的 `afterEach` 与 [LLM 运行时](../../src/llm/runtime.ts)的路由注销位置：确认 Agent 和适配器路由完成清理。

如果本机没有这条 VS Code 配置，可在 `.vscode/launch.json` 的 `configurations` 数组加入：

```json
{
  "name": "调试 LLM 插件真实请求测试（DeepSeek）",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/.test-dist/agents/tests/harness.test.js",
  "runtimeArgs": ["--test", "--test-isolation=none", "--test-name-pattern=LLM 插件调用真实模型"],
  "cwd": "${workspaceFolder}",
  "env": { "FLY_NOVEL_REAL_LLM_TEST": "1" },
  "preLaunchTask": "编译调试测试",
  "outFiles": ["${workspaceFolder}/.test-dist/**/*.js"],
  "sourceMaps": true,
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```
