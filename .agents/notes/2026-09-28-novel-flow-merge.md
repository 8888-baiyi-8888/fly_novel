# 小说流代码并入章节流仓库（novel-flow 包）

日期：2026-09-28
范围：把小说流（建书管线 N0→N8）源码从 `Q:\fly_novel_02\fly_novel` 整体并入章节流仓库 `Q:\repos\fly_novel`，保证「小说流建书 → 书目录 → 章节流七步」全流程在同一仓库内贯通。

## 背景与判定

- 章节流仓库是 pnpm workspace monorepo（harness / llm / util），git 历史与小说流同源但已分叉：
  - 章节流保留了 harness（session/agent-loop 演进中）与章节流数据面（novel=gates/runtime/services/types）；
  - 小说流保留了完整建书管线（novel N0→N8）、建书 CLI（app/main.ts --step）、qwen 适配器、memory-model。
- 两仓库 tsconfig 同为 `module: NodeNext + type: commonjs`；小说流源码使用**无扩展名相对导入**（CJS 解析下合法），章节流源码使用 `.ts` 后缀导入（rewriteRelativeImportExtensions）。两种风格在同一根 tsconfig 下均可编译，**无需批量改导入后缀**。

## 接入方案（已实施）

1. **新 workspace 包 `src/novel-flow/`**：小说流 `src/novel/*` 整体复制（70 文件，含 tests/README），保留源码原样。
2. **跨层引用收敛**（20 处固定替换，novel-flow 内）：
   - `../../harness/model/contract` → `../adapters/model-contract`（12 处源码）
   - `../../harness/adapters/models/memory-model` → `../adapters/memory-model`（7 处测试）
   - `../../config/paths` → `../paths`（workspace/write.ts）
3. **支撑文件复制**：
   - `src/novel-flow/adapters/model-contract.ts`（harness ModelClient 契约搬入，novel-flow 自足）
   - `src/novel-flow/adapters/memory-model.ts`（内存模型，import 改 `./model-contract`）
   - `src/novel-flow/paths.ts`（重写：`PROJECT_ROOT = process.cwd()`，artifacts 落仓库根；与章节流凭据系统 `src/config/paths.ts` 分离）
4. **建书 CLI 迁入**：
   - `src/app/main.ts`（N0→N8，--step/--model memory|real/--clarify/--force/--book/--file/--input/--help），import 全部改指 `../novel-flow/*` 与 `../novel-flow/adapters/memory-model`；
   - `src/app/input-guide.ts`（USAGE/INPUT_GUIDE，--help 用；此前漏复制导致编译失败，已补）；
   - `src/app/configured-model.ts`（ConfiguredLlmModel 桥接：`@fly-novel/llm` + novel-flow 契约）。
5. **模型适配器接线**：
   - `src/llm/adapters/openai-compatible.ts`（qwen 兼容端点；自小说流拷贝，内部引用自洽）；
   - `src/llm/index.ts` 增导 `OpenAICompatibleAdapter`；
   - `src/app/llm-adapters.ts` 注册 qwen 工厂（responseFormat json_object）。
6. **工程接线**：`pnpm-workspace.yaml` 加 `src/novel-flow`；`src/novel-flow/package.json`（@fly-novel/novel-flow，dep pinyin-pro）+ `tsconfig.build.json` + `tsconfig.test.json`（outDir `../../.test-dist-nf`）；根 `package.json` dependencies 加 pinyin-pro（dist 运行时解析）；`.gitignore` 加 `.test-dist-nf/`。

## 验证结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 章节流回归（零破坏） | `npx tsc -p tsconfig.chapters.json` + `node --test ".test-dist/workflow/tests/*.test.js" ".test-dist/novel/tests/*.test.js"` | **139/139** ✓ |
| novel-flow 建书管线 | `npx tsc -p src/novel-flow/tsconfig.test.json` + `node --test ".test-dist-nf/tests/*.test.js"` | **123/123** ✓ |
| 接入全量编译 | `npx tsc -p tsconfig.build.json`（app+config+novel+workflow+novel-flow） | 通过（exit 0）✓ |
| novel-flow 包独立构建 | `pnpm --filter @fly-novel/novel-flow run build` | dist 58 js ✓ |
| 书目录→BookRuntime 衔接 | `buildRuntimeFromBookWorkspace(章节流仓库 artifacts/n7-workspace/chuxiafengqingyan)` + `settleChapter(1, 空增量)` | `applied`，12 条伏笔入账 ✓ |

真实书产物（N5/N6/N7）已复制进章节流仓库 `artifacts/`（源 `Q:\fly_novel_02\fly_novel\artifacts` 只读，未动）。

## 遗留（非本任务引入 / 待跟进）

1. **harness 既存编译坏块**：`src/harness/agent-loop/{agent,inbox}.ts` 引用 `../session` 未导出的类型（ProjectionDefinition/SessionProjectionRegistry/Inbox/MessageId/z 等），导致 `pnpm run build:packages` 与 `npx tsc -p tsconfig.test.json`（全 src）失败。git 确认本任务未触碰 harness；属底层 agent 负责人演进中工作区（commit d80b715「章节代码提交」后 session 布局变更、agent-loop 未同步）。**章节流的有效验证面是 tsconfig.build.json / tsconfig.chapters.json**（不含 harness），均通过。
2. **memory 模式全链路在空仓库 N3 读盘失败**：`main.ts --model memory` 全链路在 N3 调 `readLatestDraft()`（读 `artifacts/n1-draft/`）——小说流 memory 演示依赖仓库已有 N1 产物。空仓库需先 `--step n0/n1`（real 落盘）或直接 real 模式；属小说流既存设计，未改逻辑。
3. **平台不一致（已知）**：`platformProfile.platform="fanqie"` 与 `bookConfig.platform="晋江文学城"` 不一致（映射表未覆盖原文回退），小说流侧潜在缺陷，非接入阻断项。
4. **run-chapter 真实跑章**：需真实 agent 凭据（--base-url/--api-key/--model 或环境变量 FLY_NOVEL_*）；qwen 端点 `https://ws-qdosblm7qnaa12g9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` 经验：`enable_thinking:false` + SSE 流式 + write 超时 retry。

## 后续建议

- agent 接入后（第三方 agent 后置），run-chapter 直接用 `--workspace` 指向章节流仓库内书目录即可闭环七步。
- harness 坏块由底层 agent 负责人修复；修复前不要以 tsconfig.test.json 作为全量门禁。
