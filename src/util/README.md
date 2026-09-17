# 共享工具

本目录提供跨模块共用的基础工具，不依赖应用配置、LLM 或 Harness。

工作区包名为 `@fly-novel/util`，通过 `index.ts` 导出公共工具。跨模块使用 `import { deepFreeze } from '@fly-novel/util'`；构建方式见[项目说明](../../README.md#本地工作区包)。

`deep-freeze.ts` 导出 `deepFreeze`，原地冻结对象及通过可枚举字符串属性访问的子对象，支持循环引用，并保留 `AbortSignal` 的可变状态。

测试放在 `tests/` 中。

`brand.ts` 定义共享的字符串品牌类型。使用 `import type { Branded } from '@fly-novel/util'`，再定义如 `type SessionId = Branded<'SessionId'>` 的专用标识。相同品牌名表示相同类型，不同用途应使用不同品牌名；品牌仅在编译期存在，不执行运行时校验。
