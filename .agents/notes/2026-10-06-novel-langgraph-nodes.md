# 小说级 LangGraph 节点归属

问题：建书流程的节点散落在应用入口中，状态和步骤衔接依赖入口手写顺序，难以在图中复用。

决定：`src/workflow/novel_workflow` 持有状态 schema、建书节点、产物读写和图连接；调用方只提供 Agent 实例。`StateSchema` 是图状态与 TypeScript 状态类型的共同来源。书籍配置和长期创作控制分支并行，静态架构节点等待故事基础设定与长期创作控制完成。领域产物仍由 `src/novel-flow` 的 Agent 和确定性函数生成。

影响：`src/app/novel-workflow` 负责解析命令行、创建 Agent 和提供澄清回调；全链路调用新图，单步命令由 `single-step.ts` 从已有产物恢复输入并复用节点。`--step` 采用节点名缩写 `ni/dra/bc/sf/con/arc/sta/wor/rea`，N0～N8 产物目录保持原名。真实模式写入 `artifacts/`、书目录和 `ready.json`；内存模式全链路只预览。

验证：`pnpm typecheck`、`pnpm build`；在隔离临时目录运行内存模式整图以及原始输入、初始状态单步命令，确认无产物落盘；另以内存 Agent 运行 `persist: true` 的完整图，确认生成书目录与 `ready.json`。
