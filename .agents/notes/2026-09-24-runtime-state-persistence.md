# 2026-09-24：FakeBookRuntime 跨章状态持久化（--runtime-state）

## 背景
真实 agent 连续跑章时发现：`run-chapter.js` 每次启动 `buildFakeBookRuntime()` 都是全新内存实例，
账本/真相/时钟从 §7.7 fixtures 初始状态开始——第 1 章 settle 的推进不会带到第 2/3 章，
"跨章演进"（最初定的 FakeBookRuntime 连续 settle 3-5 章验证场景）无法成立。

## 决策
1. **`FakeBookRuntimeImpl` 增加 `snapshot()/restore()`**（`fake-book-runtime.ts`）：
   - 快照 = `{ ledger, threads, facts, states }`（plain JSON 可序列化，含 retconned 事实——不走 `truth.snapshot` 过滤视图）；
   - restore 深拷贝（record spread / threads+eventChain 逐层 copy / facts spread / states spread），不保留引用；
   - `buildFakeBookRuntime()` 返回类型升级为 `FakeBookRuntime`（`BookRuntime` + 快照能力），对节点/引擎零影响（可赋值给 `BookRuntime`）。
2. **驱动 `--runtime-state <path>`**（默认 `{storeDir}/{book}/runtime-state.json`）：
   - 启动：文件存在则 restore（坏文件/解析失败 → warn 并用 fixtures 继续，不 crash）；
   - 结束：无论结果（completed/suspended/failed）一律落盘——下一章从此状态继续。

## 验证
- tsc 零诊断；全量 **126/126**（新增 2：snapshot→restore 往返一致 + 深拷贝独立；跨章 restore 后账本延续、
  时钟 syncPoint 已推进、第二次 settle 后 advancedCount 累加且 lastAdvancedChapter 防回退不降）。
- 测试中确认的语义：fixtures H007 开局 `lastAdvancedChapter:19, advancedCount:1`（故事中段开局）；
  applyDelta 防回退取 `max(旧值, 本章)`、`advancedCount` 每次 advance +1（与 Settler 上报值无关）。

## 注意
- 已跑过的第 1/2 章没有快照（当时无此功能），第 3 章起才是真正的跨章延续起点。
- 小说流真实 BookRuntime 就绪后：快照/恢复是驱动级便利（本章节流调试用），真实服务常驻内存无需此机制；
  但 `FakeBookRuntime` 的 snapshot/restore 接口为未来"书级导出/导入"保留了形状。
