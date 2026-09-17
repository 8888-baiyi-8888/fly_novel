# LLM 与共享工具工作区包

问题：跨模块相对路径依赖文件位置，公共入口与包依赖关系不明确。

决定：保留 src 布局，将 llm 和 util 注册为 pnpm 私有工作区包，通过 workspace:* 声明依赖和 exports 暴露公共入口。Harness 暂由根项目管理，使用根项目声明的 LLM 依赖。工作区包按依赖顺序构建，产物位于各包 dist；应用产物仍在根 dist，测试产物在 .test-dist。源码检查映射到源码入口，运行时加载包产物。NodeNext 解析匹配当前 Node.js 与 CommonJS 包设置。

影响：应用与 LLM 的跨模块引用改用包名；调试任务先构建包再编译测试，并包含包产物的源码映射。归档记录不改写。

验证：本地工作区安装、两个包构建和 Node.js 公共导出冒烟测试通过。整体检查仍受 Harness 草稿中未定义的 TurnEndCancelCause、UserMessage、PromptAssembly 阻塞，不用占位类型或排除规则隐藏问题。
