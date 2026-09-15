# LLM 独立于 Harness

## 问题

模型调用实现位于 Harness 内部，应用直接调用模型时也需要引用 Harness 路径。

## 决定

将 LLM 模块迁到与 Harness 平级的 `src/llm/`，保留 DeepSeek 调用接口和行为，不保留旧路径转发。app 通过 config 读取配置，在使用凭据时按需解密，再将参数传给 LLM 模块。LLM 模块不依赖 app、config 或 Harness。

## 影响

app 的导入路径和当前目录说明同步更新；Harness 不再拥有模型提供商适配。此前配置参数传给 Harness 的记录属于历史布局，当前依赖关系以本记录及模块 README 为准。

## 验证

执行类型检查、构建与配置调用集成测试，使用虚构凭据和 fetch 替身验证新路径下的模型调用；检查旧源码路径引用、Markdown 链接和差异空白。
