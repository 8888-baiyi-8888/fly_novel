# @fly-novel/sandbox

文件修改模式与可写根计算，不注册服务、不执行文件修改或启动子进程。`workspaceWritableRoots` 包含工作区和显式附加目录；`writableRoots` 另外包含上游定义的平台临时根。`read-only` 和 `danger-full-access` 返回空根列表，后者是否绕过限制由消费方决定；这些函数不构成授权或内核沙箱。

`roots.ts` 和文件策略类型参考用户提供的 DeepSeek Harness 官方下载快照 `packages/sandbox/sandbox`，版本 `0.2.2-rc.1`，快照无已核验提交；`src/roots.ts` 的 SHA-256 为 `96efb4b8386d429ae100df377e7683d8026327d906f1dc3021399203319062e1`，`src/index.ts` 为 `0a44c9d691a200068ecfff4c1659dd205d0d6a776513a03823b54e51d5df468a`。使用 [MIT 许可证](LICENSE)。本地将错误基类导入改为 `@fly-novel/llm`，只保留文件修改所需的类型和根计算，不包含上游进程服务、Session ID 和提权接口。更新时对照快照来源重新核对许可证、文件与依赖，重放适配并运行根计算测试。
