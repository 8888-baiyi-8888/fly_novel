# fly_novel

`fly_novel` 是一个已初始化 TypeScript 环境的 Node.js 项目，目标是搭建小说创作的多 Agent 工作流框架。

## 环境要求

- Node.js `v24.20.0`
- pnpm `12.4.1`

### 安装依赖

```bash
pnpm install
```

### 常用命令

```bash
npm run typecheck # 执行 TypeScript 类型检查，不生成构建产物
npm run build     # 编译 TypeScript 源码到 dist/
npm run test      # 运行测试（需先 build）
npm run demo      # 运行创意草案整理演示（需先 build）
```

## 已实现模块

| 模块 | 位置 | 说明 |
|---|---|---|
| 模型调用契约 | `src/harness/model/` | Harness 调用大语言模型的统一接口 |
| 内存模型适配器 | `src/harness/adapters/models/` | 不发起网络请求的预置响应模型（演示/测试） |
| 创意草案整理 | `src/novel/draft/` | 建书第 1 步：用户原始输入 → 结构化创意草案（轻量 Agent） |
| 应用组装 | `src/app/main.ts` | CLI 入口，演示完整流程 |

## 架构

源码分四层：`app/`（组装）、`harness/`（通用 Agent 框架）、`workflow/`（图工作流引擎）、`novel/`（小说业务）。详见 `src/README.md`。
