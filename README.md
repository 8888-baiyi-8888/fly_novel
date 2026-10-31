# fly_novel

`fly_novel` 是以持续演化的虚拟世界为基础的小说创作项目。项目使用 TypeScript、Node.js 和插件化 Agent Harness；世界初始化与故事创作流程的开发方向见[长期开发计划](docs/development-plan.md)。

## 环境与检查

使用 Node.js 24 和 pnpm 12.4.1 或兼容版本。在仓库根目录执行：

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

构建和测试编译分别清理 `dist/` 和 `.test-dist/` 后生成产物。真实模型调用需要配置供应商与凭据，见[配置模块说明](src/config/README.md)。

## 文档入口

- [Agent Harness 和使用方式](src/agents/README.md)
- [应用入口与 Agent 调试](src/app/README.md)
- [世界初始化工作流方案](docs/workflows/word-initialization/world-initialization.md)
- [项目目录架构](docs/architecture.md)
