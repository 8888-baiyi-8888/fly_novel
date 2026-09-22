# fly_novel

`fly_novel` 是一个已初始化 TypeScript 环境的 Node.js 项目。


## 环境要求

- Node.js `v24.20.0`
- pnpm `12.4.1`

TypeScript 编译目标为 ES2023，源码可使用 `toReversed()` 等 ES2023 标准 API；构建和测试配置统一继承根目录 `tsconfig.json` 的设置。

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
```

`tsconfig.json` 为编辑器和类型检查提供包含源码与测试的统一配置，不生成产物。`pnpm run build` 按依赖顺序构建工作区包到各包的 `dist/`，再将应用源码编译到根目录 `dist/`；正式构建排除测试。`pnpm run build:tests` 先构建工作区包，再通过 `tsconfig.test.json` 将源码和测试编译到 `.test-dist/`。

## 本地工作区包

Agent 执行框架的开发顺序与阶段验收见 [ReactLoopAgent 分阶段开发计划](docs/modules/react-loop-agent-plan.md)。

相对导入支持 `.ts` 后缀，例如 `import { value } from './types.ts'`；编译时通过 `rewriteRelativeImportExtensions` 将输出路径改写为 `.js`。工作区包仍使用 `@fly-novel/llm` 等包名导入。

`pnpm-workspace.yaml` 登记 `src/harness`、`src/llm` 和 `src/util` 三个私有包，依赖通过 `workspace:*` 引用。安装依赖后，跨模块使用公共入口：

```ts
import type { LlmFailure } from '@fly-novel/llm';
import { deepFreeze } from '@fly-novel/util';
```

编辑器和类型检查通过源码映射解析公共入口，无需预先构建。Node.js 通过工作区链接和各包的 `exports` 加载构建产物；运行测试或应用前使用上述构建命令。新增依赖应声明在实际使用它的包中，包内实现继续使用相对导入。

VS Code 调试任务应运行 `pnpm run build:tests`，源码映射范围包含 `.test-dist/**/*.js` 与 `src/*/dist/**/*.js`。本机调试配置位于被忽略的 `.vscode/` 中。
