# fly_novel

`fly_novel` 是一个已初始化 TypeScript 环境的 Node.js 项目。

开发设计见[模块文档索引](docs/modules/README.md)。


## 环境要求

- Node.js `v24.20.0`
- pnpm `12.4.1`

### 安装依赖

```bash
pnpm install
```

### 常用命令

添加 TypeScript 源码后可使用：

```bash
pnpm run typecheck # 执行 TypeScript 类型检查，不生成构建产物
pnpm run build     # 编译 TypeScript 源码到 dist/
pnpm test          # 编译并运行 src/*/tests/ 下的测试
pnpm run character-agent-example # 使用本机 DeepSeek 配置调试角色 Agent 模型调用
```

`tsconfig.json` 为编辑器和类型检查提供包含源码与测试的统一配置，不生成产物；`tsconfig.build.json` 排除测试和独立包源码，将应用输出到 `dist/`；`tsconfig.test.json` 将源码和测试编译到 `.test-dist/`。

## 工作区包

`pnpm-workspace.yaml` 登记 [@fly-novel/agents](src/agents/README.md)，根项目通过 `workspace:*` 引用。包管理自己的运行依赖、公共导出和构建产物；新增 Agent 依赖声明在包清单内。

`pnpm run build` 先构建 Agent 包到 `src/agents/dist/`，再构建应用。`pnpm run build:tests` 先构建包再编译测试，`pnpm test` 调用该前置步骤。`pnpm run typecheck` 检查包边界和项目源码，不依赖构建产物。CommonJS 输出与 NodeNext 模块解析保持一致。
