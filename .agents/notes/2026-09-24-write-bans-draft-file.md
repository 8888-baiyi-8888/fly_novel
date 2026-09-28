# 2026-09-24：write 十条禁令 + --draft-file 正文导出

## 背景
真实 agent 端到端已跑通第一章（direct→simulate→merge→write→audit→censor→settle 全 completed）。
用户反馈正文"AI 味太重"，要求把《小说级开发工作流文档》§7.3 的十条写作禁令编入 write 节点；
并要求驱动支持 `--draft-file` 自动导出正文草稿。另提出工程问题：规则类内容放代码还是放文档？

## 决策
1. **运行时规则必须进代码**（或代码加载的资源文件），README 不能替代——workflow 运行时只读得到
   指令常量，文档不会自动进 prompt；指令常量受编译期检查。README/AGENTS 只登记规则出处与维护索引。
2. **十条禁令抽为结构化常量数组 `WRITE_BANS`**（`src/workflow/nodes/write.ts`，来源 §7.3，逐条可增删），
   指令内按序号展开。将来规则膨胀或需 A/B 时，整目录抽离为 `src/workflow/prompts/`（TS 模块导出，无加载问题）。
3. **`--draft-file` 参数**：`run-chapter.js` 在 run 后（completed/suspended 均适用）只要有 write 产物，
   自动写正文草稿；默认路径 `{storeDir}/{book}/{chapter}.md`，`--draft-file` 覆盖。从 `store.load` 读产物
   （`ChapterWorkflowResult` 不含 artifacts，产物在持久化记录里）。

## 验证
- `npx tsc -p tsconfig.chapters.json` 零诊断。
- 全量测试 **124/124**（新增：write 指令含全部禁令 + context 含拍摄单；禁令计数=10）。
- 真实驱动行为（自动导出 md / --draft-file 覆盖）需带 key 跑一次确认（依赖 MaaS 端点，本环境不代跑）。

## 追记：write 真实运行超时 → 自动重试 + 默认超时放宽

- 第 3 章真实跑：direct/simulate/merge 全过（simulate few-shot 生效），write 撞默认 120s 超时
  （正文生成 + 十条禁令自检耗时长）。
- 修复：①`write` 节点 agent 调用失败（超时/网络抖动）由 `fail` 改为 **`retry` 回 write**（引擎预算内自动重跑，
  耗尽挂起保留现场）——settle/direct 等仍保持 fail（避免破坏既有失败语义测试）；②驱动默认 `--timeout` 120s → 240s。
- 验证：tsc 零诊断；127/127（新增：write 失败 → retry 断言）。真实行为待用户重跑确认。

