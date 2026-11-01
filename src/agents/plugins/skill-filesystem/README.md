# @fly-novel/skill-filesystem

文件系统 Skill 提供方及其 Cordis 插件。可信调用方提供绝对根目录，查询时根目录必须位于授权工作目录内。提供方查询一级子目录中的 `SKILL.md`；没有 `SKILL.md` 的目录被忽略。发现时分块读取并校验 YAML 元信息，最多预读最后一块中少量正文，元信息上限为 1 MiB；查询不校验正文。按名称加载时重新读取完整文件，检查正文、UTF-8 和文件大小（上限 1 MiB）。两种读取均检查目录和文件符号链接的实际位置，元信息无效或访问错误使查询失败。

加载结果提供 Skill 资源目录，正文引用的其他资源须由读取工具独立授权。例如 `read_file` 以其可信调用方指定的工作目录为边界：若工作目录是 Skill 资源目录，不能读取该目录之外的文件；若工作目录是更大的工作区，则仍可读取工作区内其他文件。返回资源目录本身不会更改读取工具的授权范围。

`filesystemSkillPlugin` 依赖 `skills` 服务，使用配置的 `root` 注册提供方并随插件作用域注销；`filesystemSkillPluginDefinition` 是 Harness 注册定义。注册不自动授予模型其他目录权限。路径检查不防御其他进程在检查与打开之间替换目录或符号链接，调用方须保证目录不被不可信进程并发修改。

参考 [DeepSeek Harness 文件系统提供方](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)。本包暂不支持默认搜索目录、扁平 Markdown 文件或文件监听。YAML 解析使用 ISC 许可证的 `yaml` 包。

在仓库根目录执行 `pnpm --filter @fly-novel/skill-filesystem build` 构建。
