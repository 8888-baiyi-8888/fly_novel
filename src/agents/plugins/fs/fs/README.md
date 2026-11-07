# @fly-novel/fs

文件系统服务契约和 Cordis 事件；本包不提供文件后端、授权或沙箱。具体文件操作和资源清理由后端负责。

源码来自 [DeepSeek Harness 文件系统契约](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/fs/fs)，固定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，使用 [MIT 许可证](LICENSE)。源码移至包根目录，构建使用项目 CommonJS 配置。

本地将补丁、品牌和错误基类导入改为项目包；暂时移除上游的 `sandboxMode` 属性和文件修改方法的 `sandboxPolicy` 参数及其导入，因本阶段没有沙箱契约或实现。后续接入 `dsh-fs-sandbox` 前必须重新核对并恢复相应契约，不能将当前接口视为与上游完全兼容。更新时对照固定提交重新应用本地修改，并执行类型检查、构建及相关服务测试。
