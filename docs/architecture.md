# 项目目录架构

本文用于开发时查阅项目根目录下各一级目录和文件的用途。目录内部的结构与细节由各目录自己的文档说明。

| 目录或文件 | 用途 |
| --- | --- |
| `src/` | 项目源码与所属模块的测试，包含应用入口、配置管理、Agent、工作流和小说业务。详见[源码目录说明](../src/README.md)。 |
| `docs/` | 面向开发者的项目架构、模块设计、业务工作流和工程决策文档。详见[文档协作规则](AGENTS.md)。 |
| `.agents/` | Agent 开发协作中的重要工程决策记录，说明问题、决定、影响与验证。 |
| `.fly-novel/` | 应用配置样例、本机配置、加密凭据和角色记忆数据；仅配置样例提交 Git。 |
| `.vscode/` | 本机 VS Code 调试与任务配置，受 Git 忽略规则保护。 |
| `.git/` | Git 管理的版本历史、索引和仓库元数据。 |
| `node_modules/` | 包管理器安装的第三方依赖，由依赖安装过程生成。 |
| `dist/` | 应用源码编译后的构建产物，由应用构建过程生成。 |
| `.test-dist/` | 测试及其依赖源码的编译产物，由测试编译过程生成。 |
| `tmp/` | 本地开发和验证过程中使用的临时文件，受 Git 忽略规则保护。 |
| [README.md](../README.md) | 项目介绍、环境要求、常用命令和开发文档入口。 |
| [AGENTS.md](../AGENTS.md) | 项目开发协作规则，规定代码、文档、测试与工程变更的约束。 |
| [.gitignore](../.gitignore) | Git 忽略规则，排除本机配置、凭据、依赖、构建产物和临时文件等内容。 |
| [package.json](../package.json) | 根项目的包信息、依赖声明，以及构建、类型检查、测试和工具启动脚本。 |
| [pnpm-workspace.yaml](../pnpm-workspace.yaml) | pnpm 工作区配置，登记由仓库统一管理的子包。 |
| [pnpm-lock.yaml](../pnpm-lock.yaml) | pnpm 生成的依赖锁文件，记录依赖解析结果，保证安装版本一致。 |
| [tsconfig.json](../tsconfig.json) | TypeScript 基础配置，供编辑器和源码、测试的类型检查使用，默认不生成编译产物。 |
| [tsconfig.build.json](../tsconfig.build.json) | 应用正式构建配置，继承基础配置，将应用编译到 `dist/`，排除测试和独立包源码。 |
| [tsconfig.test.json](../tsconfig.test.json) | 测试编译配置，继承基础配置，将源码与测试编译到 `.test-dist/`。 |
