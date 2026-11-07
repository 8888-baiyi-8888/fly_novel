# @fly-novel/fs

文件系统服务契约和 Cordis 事件；本包不提供文件后端、授权或沙箱。具体文件操作和资源清理由后端负责。

源码来自 [DeepSeek Harness 文件系统契约](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/fs/fs)，固定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，使用 [MIT 许可证](LICENSE)。源码移至包根目录，构建使用项目 CommonJS 配置。

本地将补丁、品牌和错误基类导入改为项目包；暂时移除上游的 `sandboxMode` 属性和文件修改方法的 `sandboxPolicy` 参数及其导入，因本阶段没有沙箱契约或实现。后续接入 `dsh-fs-sandbox` 前必须重新核对并恢复相应契约，不能将当前接口视为与上游完全兼容。更新时对照固定提交重新应用本地修改，并执行类型检查、构建及 `src/agents/tests/fs-contract-types.test.ts` 等相关测试。

服务由具体后端在明确的 Cordis 插件作用域内注册，包本身不注册后端。Harness 按提供服务的插件隔离 Agent 作用域；调用方负责关闭已初始化的监听句柄，初始化期间的取消由传入信号控制。基类默认不支持监听。`src/agents/tests/fs-service-lifecycle.test.ts` 使用受控替身验证装配、事件和清理，不验证真实后端的文件权限、操作或监听竞争。

文件事件使用共享的 Cordis 事件总线，服务隔离不会自动隔离监听器；监听器随注册它的插件作用域注销。后续观察策略和工具接入时必须根据调用上下文明确匹配事件，验证不同 Agent 的观察和意图不会相互干扰，不能将事件总线视为授权边界。
