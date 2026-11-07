# @fly-novel/fs-local

本机文件系统后端，继承 [`@fly-novel/fs`](../fs/README.md) 并使用 [`@fly-novel/fs-patch`](../fs-patch/README.md)。可信调用方在独立 Cordis 插件作用域显式装配 `LocalFileSystem`，Harness 插件声明 `provide: 'fs'`；导入包不创建服务或访问文件。未受授权机制保护时不得向生产 Agent 装配本后端。

配置 `cwd` 是相对路径解析基准，默认为进程工作目录；它不限制绝对路径、父目录或符号链接。`diffBasisMaxBytes` 默认为 10 MiB，限制覆盖前后用于差异展示的内容大小，须为正安全整数且不超过运行时缓冲区和字符串限制。调用方负责关闭已初始化的监听句柄；文件事件使用共享 Cordis 总线，见文件契约说明。

源码来自用户提供的 DeepSeek Harness 官方下载快照，包版本 `0.2.2-rc.1`；下载快照没有可核验的 Git 提交标识，不将其标记为固定提交。源文件 SHA-256：`src/index.ts` 为 `e43441b0ad597efe3a8f4f111d4de1322ca38c8b62ec9842a813361cb79de334`，`src/fsio.ts` 为 `f349a91cb11fbf7da5cb3f7fca44bdace72a2a72a1527ec784f790c711960b41`，`src/win32.ts` 为 `2fa3696f3c852a3206c21221f6269673c3e1c1cb15fb1f6f7fa75b27b1ea7d77`。适用 [MIT 许可证](LICENSE)，上游地址为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/fs-local)。

本地将源码移至包根目录，将上游文件契约和补丁库导入改为项目包，使用项目 CommonJS 构建；文件操作算法保持原样。当前文件契约不含上游沙箱参数，接入沙箱前须重新核对。更新时取得可追溯的上游源码，核对许可证与依赖、比较上述三个文件并重新应用导入和构建调整，执行包类型检查、构建及所属测试。

监听依赖 `chokidar`；Windows 上替换已有文件时惰性加载原生 `koffi` 以保留 DACL。平台、权限、真实磁盘行为和监听竞态须通过后续聚焦测试验证；版本保护和实例内锁不提供跨进程协调。

文本读取严格按 UTF-8 解码，并检查前 8192 字节中的 NUL；该采样不保证识别所有二进制文件。完整字节读取在超过调用方上限时返回 `FS_TOO_LARGE`，字节窗口只返回请求范围内的数据。读取前发现缺失文件或非普通文件分别报告 `FS_NOT_FOUND` 和 `FS_NOT_REGULAR_FILE`；读取流在检查元数据之后发生的底层 I/O 错误可直接传播，例如文件在打开前消失时的 `ENOENT`。监听句柄和流的行为及当前平台验证见 `src/agents/tests/fs-local-read.test.ts` 和后续监听测试。

修改操作在单个后端实例内按目标标识加锁；移动按排序后的两个目标加锁，先发布目标再删除源，源删除失败以 `sourceDeleted: false` 报告。移动通过最后取消检查点后会完成并报告这两个效果；其他写入在发布前可取消。目标发布成功后暂存目录清理失败不会撤销已发布内容，可能留下暂存目录。外部进程和其他后端实例不共享锁，版本检查与发布之间仍可能受到外部修改或路径替换影响；不将其视为跨进程事务或授权边界。
