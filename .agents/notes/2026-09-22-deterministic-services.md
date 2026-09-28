# 2026-09-22 确定性服务纯函数线（HookLedger lifecycle/准入/六步校验/不可变合并）

## 背景

agent 开发未就绪（A 负责）。章节流先行把文档规定的**确定性服务**以纯函数 + 类型落地，
延续 §5.3 Dispatch 校验闸门"纯函数 + 测试 + 决策记录 + 交付"模式。本批为第九次代码交付。

范围：`src/novel/services/`（HookLedger / TimelineManager / TruthOracle 接口契约，
完整实现 HookLedger 核心纯函数）；`src/novel/gates/apply-delta-gate.ts`（六步校验链 ①-⑤）。
⑥ 不可变合并属 HookLedger 的 `mergeHookOps`。§11.3 原子落盘属真实 WorkflowStore，不在本次。

## 决策记录

### 1. W[phase] 权重表文档未给出 → 用阶段序数

**问题**：§4.3 `phaseReady = W[phase] >= W[P.minimumPhase]` 的权重值表文档未提供。
**决定**：`PHASE_LEVEL = { opening: 0, middle: 1, late: 2 }`（序数比较），
`phaseReady = 当前阶段序数 >= 档位最低阶段序数`。
**影响**：语义等价"当前阶段不低于最低书阶段"；具体权重值不影响布尔判定。
**验证**：lifecycle 测试覆盖 immediate（opening 即可 ready）、slow-burn（须 middle）、endgame（须 late）。

### 2. 文档 §4.4 示例数值与 §4.2/§4.3 公式冲突 → 忠实公式

**问题**：§4.4 债务表示例称"第 21 章（全书 100 章 → middle 阶段）"，且 H011 slow-burn
在 ch21 显示 STALE（advancePressure=35，含 stale 加 8）。但 §4.3 公式
`p=N/T`，21/100=0.21 < 0.33 → **opening**；slow-burn 最低书阶段是 middle →
phaseReady=false → 不 stale，advancePressure=27。
**决定**：以 §4.2 档位表 + §4.3 公式代码为权威实现，§4.4 示例数值视为手写示意。
**影响**：H011 在 ch21 的债务表渲染值（若按公式）与文档示例不同；行为以公式为准。
**验证**：lifecycle 测试显式断言 bookPhase(21,100)=opening、slow-burn 在 middle 阶段（ch35）才 stale。

### 3. ① schema 校验：文档指定 Zod，项目无该依赖 → 手写形状校验

**决定**：`schemaError` 手写：typeof 检查、`isInt`（整数且 ≥0）、payoffTiming 枚举、
open.type 词表。失败 → 整批 rejected-batch（状态不变）。
**影响**：无新运行时依赖；错误信息为中文可读。
**验证**：apply-delta-gate 测试覆盖非法 to / 负数 advancedCount / 未知 op / 词表外 type。

### 4. ③ 降级为 advance 的重写方式

**决定**：resolve 未 readyToResolve → 重写为
`{ op:'advance', hookId, how, to:'progressing', lastAdvancedChapter: 本章, advancedCount: 旧+1 }`，
warning 登记 resolve-not-ready。降级后的 advance 再过 ⑥ 合并（max 语义幂等）。
**影响**：避免过早引爆；how 字段保留供 advance 语义复用。
**验证**：H014 endgame 在 middle 阶段 resolve → 降级为 advance 用例。

### 5. ⑤ 时间线可达性注入方式

**问题**：HookOp 与 HookRecord 均无 threadId 映射，canReach(threadId, hookId, chapter)
无法在纯函数内自足。
**决定**：`resolvableAt?: ReadonlySet<HookId>` 由调用方（TimelineManager 判定后）注入；
缺省视为全部可达。TimelineManager.canReach 仅落接口签名。
**影响**：TimelineManager 行为实现后接线即可，闸门不改签名。
**验证**：resolvableAt 不含目标 → resolve 被拒用例。

### 6. advance 语义修正：是"推进"而非"状态迁移"

**问题**：初版用 `canTransitionHookStatus(from,'progressing')` 判定 advance，
但该函数对 'progressing'→'progressing' 返回 false——已推进中的伏笔**持续**推进会被误拒
（H007 在 ch21 推进即触发）。这是 §11.2 ⑥"status 只能沿 open→progressing→resolved 前进"
只约束**跨状态迁移**，不约束同态推进。
**决定**：advance 允许 status ∈ { open, progressing }；resolved（终态）与 deferred（须先恢复）拒绝。
**影响**：持续推进合法，计数正常累加。
**验证**：新增"progressing 持续推进合法"用例（修复后全绿）。

### 7. 合并的防回退语义

**决定**：lastAdvancedChapter = max(旧值, 本章)（文档 §11.2 ⑥ 原文；Settler 上报值仅作
校验参考，不直接写入——防幻觉写未来）；advancedCount = max(旧+1, 上报值)（计数且防回退）。
**影响**：回退/幻觉数据不会污染账本。
**验证**：防回退用例（旧 lastAdvanced=30 上报 21 → 仍 30；旧 count=3 上报 1 → 4）。

### 8. mention 只登记不计数

**问题**：§11.2 ⑥"mention 只影响本章是否被处理过，不动任何计数字段"；
HookRecord（§3.5）无 lastMentionedChapter 字段。
**决定**：merge 不改账本字段，仅输出 `touched: HookId[]`（供 audit/health 消费），
不擅自给 §3.5 模型加字段。
**影响**：账本模型保持文档原样；mention 的处理痕迹在合并输出层。
**验证**：mention 用例断言账本不变 + touched 正确。

### 9. open 的新增字段映射

**决定**：open → 新 HookRecord：编号自动分配（现有最大 H 编号 +1，如 H007→H008）、
startChapter=本章、lastAdvancedChapter=0、advancedCount=0、status='open'、
notes=echoHint（§4.4 open 指令的 echoHint 即埋设原文摘录，对应 §3.5 notes）。
open.type 须在 8 类词表内，否则 ① 拒绝整批、⑥ 兜底跳过。
**影响**：词表外类型被拒，防脏数据入账。
**验证**：open 新增用例（新编号/字段映射）。

### 10. TimelineManager / TruthOracle 仅契约层

**决定**：只落地 §16.1 签名；ThreadSnapshot/TruthSnapshot/Validation 为推断类型
（Record<ThreadId,Thread>、{facts}、{valid,violations}），注释标注实现时校准。
**影响**：为后续服务实现预留接缝；不阻塞当前纯函数线。
**验证**：类型编译通过。

### 11. applyDeltaPure 编排入口：独立文件避免循环依赖

**问题**：把 validateApplyDelta（gates）+ mergeHookOps（services）串成单一入口时，
若放 services/hook-ledger.ts 会形成 services → gates → services 循环 import（gates 依赖
services 的 lifecycle）。
**决定**：组合入口放独立文件 `src/novel/services/apply-delta.ts`，依赖方向单向无环：
apply-delta → gates → hook-ledger。输入含 totalChapters（BookConfig.targetChapters，
纯函数不访问配置）；rejected-batch 时返回原账本引用（状态不变语义），applied 时返回
新账本 + warnings + touched + skipped。
**影响**：HookLedger.applyDelta（§16.1 接口）的真实存储实现内部调它再事务落盘；
§11.3 原子落盘仍不在纯函数范围。
**验证**：apply-delta.test.ts 7 用例（通过/整批拒绝 ×2/降级/依赖/可达/混合批 + 不可变断言）。

### 12. viewForChapter：指令判定与挂起/结清排除

**问题**：§4.4 HookContext 各字段与 §4.3 压力指令的精确映射需要定案。
**决定**：
- mustResolve = resolvePressure ≥ 40；canResolve = readyToResolve 且未达 MUST（含 SHOULD 30-39）；
  mustAdvance = advancePressure ≥ 8 或 (stale && !readyToResolve)；canAdvance = 未达 MUST_ADVANCE 且
  status ∈ {open, progressing}（可推进未强制）。
- mustNotDefer = coreHook ∪ mustResolve（§3.5 / §4.3"不可 defer"）。
- resolved（已结清）与 deferred（主动挂起）不发任何指令、不进 pressure/staleDebt——
  HookContext 无 deferred 字段（§4.4），挂起是显式决定，不追加压力指令；
  activeCount 统计未 resolved（deferred 仍占预算，§4.6）。
- pressure.score = max(advancePressure, resolvePressure)；label 优先级
  MUST_RESOLVE > MUST_ADVANCE > SHOULD_RESOLVE > OK。
- budget.cap 默认 12（§4.4 示例值，真实值应由平台参数配置）；openAllowed = activeCount < cap。
**影响**：与 §5.3 dispatch-gate 校验闭环（mustResolve/mustAdvance 全覆盖等规则的输入源）；
H014（endgame 在 ch21）按公式会 MUST_ADVANCE，与 §4.4 示例"建议区"不符——示例偏差已在第 2 条记录。
**验证**：view-for-chapter.test.ts 10 用例（含 §7.7 fixture 精确数值断言：H007 score=49 label MUST_RESOLVE）。

## 验证

- 全量 typecheck 基线保持：novel+workflow 零诊断（harness 的 25 条 DSH 悬空诊断未被触碰）。
- 测试 44 → 84，84/84 通过：
  novel 57 = types 2 + chapter-runtime 5 + dispatch-gate 10 + hook-ledger 15 + apply-delta-gate 8 + apply-delta 7 + view-for-chapter 10；
  workflow 27 不变。
- 临时验证文件（tsconfig.novel-check.json + .test-novel）已清理。

## 遗留（非本次范围，已标注）

- §11.3 原子落盘：属真实 WorkflowStore，需存储层。
- viewForChapter / audit / health：依赖账本存储与 SceneSheet 审计逻辑。
- TimelineManager.canReach / TruthOracle 行为实现。
- HookLedger.applyDelta 的编排组合（校验 + 合并 + 落盘）留待存储层。
