# fly_novel

`fly_novel` 是一个 TypeScript 项目，目标是搭建小说创作的多 Agent 工作流框架。

## 环境要求

- Node.js `v24.20.0`
- pnpm（项目锁定版本见 `package.json` 的 `packageManager` 字段）

### 安装依赖

```bash
pnpm install
```

### 常用命令

```bash
pnpm run typecheck # 执行 TypeScript 类型检查（源码与测试），不生成构建产物
pnpm run build     # 正式构建（tsconfig.build.json），排除测试，输出 dist/
pnpm test          # 编译测试到 .test-dist/ 并运行全部自动化测试
pnpm run demo      # 运行创意草案整理演示（内存模型版）
pnpm run credentials / pnpm run init-encryption-key  # 凭据加密与密钥初始化（见 src/config/README.md）
```

## 已实现模块

| 模块 | 位置 | 说明 |
|---|---|---|
| LLM 调用 | `src/llm/` | 适配器接口、运行时、DeepSeek 适配器与 OpenAI 兼容适配器（qwen 等） |
| 配置与凭据 | `src/config/` | settings.json 读取、AES-256-GCM 加密凭据与密钥管理 |
| Agent 运行框架 | `src/harness/` | Agent 接口、模型调用契约（`ModelClient`）、会话与工具等规划 |
| 创意草案整理 | `src/novel/draft/` | 建书第 1 步：用户原始输入 → 结构化创意草案（轻量 Agent） |
| 应用组装 | `src/app/` | CLI 入口（main / credentials / init-encryption-key）、LLM 桥接与供应商注册 |

## 架构

源码分四层：`app/`（组装）、`harness/`（通用 Agent 框架）、`workflow/`（图工作流引擎）、`novel/`（小说业务）。详见 `src/README.md`。真实模型调用统一走 `src/config`（解密凭据）+ `src/llm`（适配器路由）+ `src/app/call-llm.ts`（应用入口），不读取 `.env`。
