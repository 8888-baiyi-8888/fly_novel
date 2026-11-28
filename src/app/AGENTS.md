# src/app 目录说明

## 仓库结构

- `README.md`：目录职责和使用说明。
- `agents/`：各类 Agent 的应用层创建入口。
- `story-workflow.ts`：故事工作流的模型和导演装配、审阅与继续、记录查询、进度核查和场景设置入口。
- `story-world-materials.ts`：绑定故事使用的可信世界与交付读取范围。
- `story-map-scene.ts`：校验场景地图需求、授权和当前地图证据。
- `story-character-participation.ts`：绑定同一子故事中的人物档案及场景参与范围。
- `story-character-runtime.ts`：装配、复用和释放角色实例，取得结构化回应。
- `story-scene-interaction.ts`：建立场景互动记录、核对来源和组织推进。
- `story-event.ts`：在可信世界运行范围内采用并重读已结算的场景事件。
- `story-convoy-state.ts`：绑定商队状态目标、核对事件证据与状态变化授权。
- `story-world-schedule.ts`：可信应用的世界时间窗、并行场景领取和结算入口。
- `story-schedule-context.ts`：演绎回调持有的角色、经历和共享状态许可。
- `story-workflow-debug.ts`：使用本机真实模型与模拟演绎运行整轮故事的调试入口。
- `tests/`：所属模块的自动化测试。
- `world-initialization-entry.ts`：世界初始化可信应用及业务服务装配入口。
- `world-initialization-files-debug.ts`：世界初始化受控文件工具的真实模型交互调试入口。
- `world-initialization-full-example.ts`：世界初始化全流程真实模型样例，用户输入由文件顶部字符串模拟。
- `world-initialization-progress.ts`：世界初始化样例的主 Agent 实时进度提示。
- `world-initialization-resume.ts`：世界初始化样例既有任务、会话与成果的续跑前核查。
- `world-initialization-workflow.ts`：世界初始化任务、讨论、审阅与发布的可信交互 API。
- `world-review.ts`：世界资料审阅正文、差异与建议的可信应用展示入口。
