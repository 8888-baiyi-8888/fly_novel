# fly_novel

`fly_novel` 是一个已初始化 TypeScript 环境的 Node.js 项目。


## 环境要求

- Node.js `v24.20.0`
- npm `12.0.2`

### 安装依赖

```bash
npm install
```

### 常用命令

添加 TypeScript 源码后可使用：

```bash
npm run typecheck # 执行 TypeScript 类型检查，不生成构建产物
npm run build     # 编译 TypeScript 源码到 dist/
npm test          # 编译并运行 src/*/tests/ 下的测试
```

`tsconfig.json` 为编辑器和类型检查提供包含源码与测试的统一配置，不生成产物；`tsconfig.build.json` 排除测试并输出到 `dist/`；`tsconfig.test.json` 将源码和测试编译到 `.test-dist/`。
