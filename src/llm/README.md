# 大语言模型调用

本模块与 `harness/` 平级，负责模型调用接口与提供商适配。`adapters/deepseek.ts` 提供继承 `LlmAdapter` 的 `DeepSeekAdapter`，构造时接收地址和 API Key，调用时接收统一的 `GenerateOptions`，不依赖 app、config 或 Harness，也不读取应用配置文件。

`app/call-llm.ts` 负责读取配置、按需解密凭据，按 `provider` 选择适配器工厂，创建 `LlmRuntime` 并注册适配器，通过运行时调用后在 finally 中注销路由。该便捷入口接收统一消息，聚合文本块并返回文本或 `null`；失败结束块转换为 `LlmError`。需要消费推理或工具调用的调用方应直接使用运行时的数据块。

## 模块职责

工作区包名为 `@fly-novel/llm`，跨模块通过 `index.ts` 公共入口导入，例如 `import type { LlmFailure } from '@fly-novel/llm'`。构建与依赖声明见[项目说明](../../README.md#本地工作区包)。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 公共导出，不承载运行时实现。 |
| `adapter.ts` | 适配器接口、模型解析及绑定到同一代实例的调用。 |
| `runtime.ts` | Cordis 服务、路由注册、默认参数解析、内容投影和流式分发。 |
| `types.ts` | 供应商、附件、内容块、模型请求及流式响应协议；附件类型只在此定义。 |
| `message.ts`、`brand.ts` | 消息结构、来源、不可变快照和专用标识类型。 |
| `call-config.ts`、`retry-policy.ts` | 调用配置比较和重试策略类型声明。 |
| `content.ts` | 文件路径说明和纯文本模型的图片占位转换。 |
| `error.ts`、`adapter-failure.ts` | LLM 错误分类、参数校验和外部失败快照。 |
| `adapters/deepseek.ts` | DeepSeek 适配器：连接校验、统一消息转换、响应及用量解析。 |

## 运行时约定

`LlmRuntime` 通过 Cordis Context 创建为 `llm` 服务。调用 `registerAdapter(providers, adapter)` 注册路由；注册方持有返回的清理函数，在所属插件或应用结束时调用，清理可以重复执行。批量注册发生重复或元数据错误时，不留下部分注册。注销阻止后续请求选中该路由；已经开始的请求继续使用已取得的适配器，并由调用方的 `AbortSignal` 控制取消。

`stream(options)` 通过 `llm/stream` 中间件分发：调用 `next()` 继续，不调用则返回替代流。适配器选择、模型解析和流迭代错误转换成 `error` 或 `aborted` 结束块；中间件和消费者异常直接传播。收到结束块、消费者提前停止或迭代失败时关闭迭代器，关闭失败继续抛出。运行时将取消信号传给适配器，适配器负责结束正在进行的网络操作。

文件投影可使用 Context 中的 `attachments.fileHostPath(ref)` 和 `fs.processPathFromHostPath(path)` 服务。服务缺失或附件返回 `ATTACHMENT_NOT_FOUND` 时，模型收到无法访问的文本说明；其他错误进入请求失败流程。纯文本模型的图片被替换为占位文本，原消息不变。

DeepSeek 适配器使用 HTTP `stream: false`，收到并校验完整响应后发出 `block-start`、增量、`block-end`、可选 `usage` 和 `finish`，不提供网络层逐 Token 推送。支持文本、推理和工具调用；附件先由运行时投影为文本，不支持的扩展内容明确拒绝。保留原入口的 low/medium/high 推理强度，具体模型是否接受由供应商验证。请求的取消信号传给 fetch。重试策略、配置目录和模型发现保留类型约定，运行时不执行自动重试或配置目录查询；消息重放状态的组装与持久化也由调用方负责。

## 一级子目录

| 子目录 | 职责 |
| --- | --- |
| `adapters/` | 各供应商的具体适配器实现，共用根目录的 adapter.ts 契约。 |
| `tests/` | 使用模拟适配器验证路由、模型默认值、流式失败、取消、清理、内容投影和错误快照。 |

DeepSeek 请求与响应字段参考 [官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。
