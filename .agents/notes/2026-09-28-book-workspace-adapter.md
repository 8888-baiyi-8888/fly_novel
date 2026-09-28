# 决策记录：书目录 → BookRuntime 适配器（小说流 N7 → 章节流）

日期：2026-09-28
仓库：Q:\repos\fly_novel（章节流侧）
上游：Q:\fly_novel_02\fly_novel（小说流侧，N0→N8 已真实跑通《初夏逢清晏》）

## 背景

小说流开发完成，产出真实书目录 `artifacts/n7-workspace/chuxiafengqingyan/`（N8 ready.json 已写）。
章节流此前用 §7.7 fixtures（FakeBookRuntime 默认态）驱动七步（direct→…→settle）。
本次对接目标：以书目录为唯一事实源构建 BookRuntime，替换默认 fixtures，节点与引擎零改动。

## 方案

新增 `src/novel/runtime/book-workspace.ts`：
- 必读书目录：inkos.json / state/{hooks,threads,facts}.json / story/beats/beats.json
- 可选补源：N5 architecture（characterCards/threadMap）、N6 state0（characterStates）；
  缺省自动定位（workspaceDir 上溯两级 = artifacts 根，按 bookId 匹配命名约定最新产物）
- 全部映射为纯函数（mapBookConfig / mapHookLedger / mapThreads / mapFacts /
  mapCharacters / mapCharacterStates / mapHookToThread），复用 FakeBookRuntimeImpl 构建运行时
- run-chapter.ts 新增 `--workspace <dir>`（+ 可选 --arch-file / --state0-file）

## 映射决策

1. **HookSeed → HookRecord**：startChapter=plantedChapter；初始全 open、
   lastAdvancedChapter=0、advancedCount=0（故事开端起跑）；expectedPayoff=payoffNote；
   payoffTiming=timing（词表完全一致）；coreHook = core 非空；notes=埋设原文。
2. **类型词表补「事件」**：真实书 H005/H012 为「事件」，章节流 HOOK_TYPES 原 8 词缺
   「事件」→ 补入（9 词）。影响面：mergeHookOps open 校验与 direct/settle prompt 枚举
   均动态生成，自动覆盖。
3. **Genre/Platform 放宽为 string**：上游 BookConfig 用原文（「现代都市」「晋江文学城」），
   章节流原字面量联合（拼音码表）过严且无业务消费 → 放宽，删除 types.test.ts 对应穷尽断言。
4. **Thread 映射**：kind 由 lineId 前缀推导（M→main/S→side/F→flashback）；status
   进行中→active/冷藏→dormant；priority main=10、side=5、flashback=3；syncPoint=0 起跑；
   eventChain 取 threadMap.events（chapter=null，canReach 依赖线时钟不依赖事件章）；
   characters 从节拍板反推（threadId 归属线的出场角色去重）。
5. **hookToThread 反推**：节拍板 hookIntentions 的【chN-hM】tag 对应 seed.beatTag → 该 beat
   的 threadId。真实结果：H004/H008/H011 → S1，其余 → M（12 条全覆盖）。
6. **facts 压缩三元组 → Fact**：subjectType 按形状推导（世界→world、含「+」→relationship、
   其余→character）；压缩 value 原样保留为 object（信息不丢）；validFrom/source=1、active。
7. **characterStates**：N6 结构化 → location/emotion 直传；goal/suspects/inventory/bonds
   初始空（小说流产物无来源，随 settle 建立）；knows 由 Fact.knownBy 派生（初始无人登记）。

## 已知缺口（对接期如实声明）

- 书目录未 JSON 化角色卡（只有 story/characters.md 人读投影）→ 依赖 N5 产物补读；
  缺 N5 时降级为节拍板角色名最小卡（console.warn 提示）。
- 小说流产物无 goals / fears / bonds 数值 / Fact.knownBy → 初始为空（S 级 agent
  prompt 注入信息量弱于 §7.7 fixture，后续由小说流补 state/characters.json 可解）。
- facts.json 是压缩字符串投影，结构化语义由 N6 state0 承载（适配器已补读）。
- ThreadEvent 无章节数值 → chapter=null（canReach 用 syncPoint，不受影响）。
- 真实书 12 条 seed 的 core 全非空 → 全部 coreHook → mustNotDefer=12（小说流建书如此，
  忠实映射；settle defer 会被拒，属正确行为）。

## 验证

- 编译：npx tsc -p tsconfig.chapters.json ✓
- 全量测试：139/139 通过（129 基线 + book-workspace.test.ts 10 条：
  映射函数 8 组 + 端到端 2 组，fixture 固化真实《初夏逢清晏》数据）
- 真实书目录端到端：加载 ✓（12 伏笔 / S:A / S1:A / 7 事件链 / 11 facts / N5N6 自动定位），
  viewForChapter(1) 全 OK、mustNotDefer=12；settle(1,空delta) applied、M.syncPoint=1、
  snapshot 可序列化 ✓

## 建议（非本仓改动）

- 小说流侧把 state/characters.json（角色卡）并入书目录，可省 N5 补读依赖；
  characterStates 同理并入 state/。
- platformProfile.platform="fanqie" 与 bookConfig.platform="晋江文学城" 不一致
  （映射表未覆盖「晋江文学城」原文导致回退 fanqie），建议小说流侧修复映射。
