# src/app 目录说明

## 仓库结构

- `README.md`：目录职责和使用说明。
- `agents/`：各类 Agent 的应用层创建入口。
- `story-workflow.ts`：故事工作流的模型和导演装配、记录查询、进度核查和场景设置入口。
- `story-world-materials.ts`：绑定故事使用的可信世界与交付读取范围。
- `story-workflow-debug.ts`：使用本机真实模型与模拟演绎运行整轮故事的调试入口。
- `tests/`：所属模块的自动化测试。
- `world-initialization-entry.ts`：世界初始化可信应用及业务服务装配入口。
- `world-initialization-files-debug.ts`：世界初始化受控文件工具的真实模型交互调试入口。
- `world-initialization-full-example.ts`：世界初始化全流程真实模型样例，用户输入由文件顶部字符串模拟。
- `world-initialization-progress.ts`：世界初始化样例的主 Agent 实时进度提示。
- `world-initialization-resume.ts`：世界初始化样例既有任务、会话与成果的续跑前核查。
- `world-initialization-workflow.ts`：世界初始化任务、讨论、审阅与发布的可信交互 API。
- `world-review.ts`：世界资料审阅正文、差异与建议的可信应用展示入口。
