import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildRuntimeFromBookWorkspace,
  mapBookConfig,
  mapCharacterStates,
  mapCharacters,
  mapFacts,
  mapHookLedger,
  mapHookToThread,
  mapThreads,
} from "../runtime/book-workspace";
import type { InkFile, HookSeed, ThreadBoardState, WorkspaceFact, BeatIntentionsBeat, CharacterCardLike, State0CharacterState } from "../runtime/book-workspace";
import type { CharacterName, EventId, HookId, ThreadId } from "../types/identifiers";

/**
 * 书目录 → BookRuntime 适配器测试。
 * fixture 固化自小说流真实产物（Q:\fly_novel_02\fly_novel\artifacts\n7-workspace\chuxiafengqingyan\，
 * 书《初夏逢清晏》，2026-09-28 真实跑通 N0→N8）。测试自包含，不依赖小说流仓库路径。
 */

/* ---------------- fixture：真实书目录数据（《初夏逢清晏》） ---------------- */

const REAL_INK: InkFile = {
  bookId: "chuxiafengqingyan",
  title: "初夏逢清晏",
  bookConfig: {
    bookId: "chuxiafengqingyan", title: "初夏逢清晏", genre: "现代都市", platform: "晋江文学城",
    targetChapters: 100, chapterWordCount: 3000, language: "zh", chapterReviewMode: "auto", maxHookRetries: 2,
    createdAt: "2026-09-28T00:30:02.280Z", updatedAt: "2026-09-28T00:30:02.280Z",
  },
};

const REAL_SEEDS: readonly HookSeed[] = [
  { hookId: "H001", beatTag: "ch1-h1", plantedChapter: 1, type: "物件", timing: "slow-burn", core: "沈清晏办公桌角落倒扣的旧相框", expectedPayoff: 24, payoffNote: "沈清晏向初夏坦白早年因信任错人导致项目流产的心理阴影，旧相框的秘密被揭开。", notes: "沈清晏办公桌角落倒扣着一个边缘磨损的旧相框，她严禁任何人触碰" },
  { hookId: "H002", beatTag: "ch3-h1", plantedChapter: 3, type: "信息差", timing: "near-term", core: "被忽略的长尾用户活跃度异常波动", expectedPayoff: 11, payoffNote: "林初夏在梳理小项目需求时，结合该异常数据重新定义目标，展现数据敏感度。", notes: "林初夏在查阅底层数据时，发现一个被忽略的长尾用户活跃度异常波动" },
  { hookId: "H003", beatTag: "ch6-h1", plantedChapter: 6, type: "秘密", timing: "near-term", core: "沈清晏对‘上季度延期’的应激反应", expectedPayoff: 14, payoffNote: "复盘间隙，沈清晏提及早年因‘不可控外部因素’导致项目流产的只言片语，呼应此处的微变。", notes: "陆远提及‘上季度延期’时，沈清晏眼神微变，手指无意识地摩挲着笔杆" },
  { hookId: "H004", beatTag: "ch8-h1", plantedChapter: 8, type: "秘密", timing: "mid-arc", core: "特定报错代码引发的梦魇", expectedPayoff: 20, payoffNote: "沈清晏深夜赶到公司并肩作战时，坦言这串代码曾毁掉她最看重的心血。", notes: "沈清晏发火时，死死盯着屏幕上的一串特定报错代码，仿佛看到了某种可怕的梦魇" },
  { hookId: "H005", beatTag: "ch12-h1", plantedChapter: 12, type: "事件", timing: "near-term", core: "被叫停的权限设置涉及核心数据隔离", expectedPayoff: 18, payoffNote: "上线前夕突发严重Bug，核心流程阻塞，正是源于那处被叫停的权限设置。", notes: "被叫停的那处权限设置，看似无关紧要，实则涉及核心数据隔离" },
  { hookId: "H006", beatTag: "ch16-h1", plantedChapter: 16, type: "秘密", timing: "near-term", core: "沈清晏早年因死磕细节导致项目延期", expectedPayoff: 24, payoffNote: "深度对话中，沈清晏坦白过往创伤，解释了她对细节苛刻到偏执的深层原因。", notes: "开发主管抱怨时提到，沈清晏早年也曾为了一个细节死磕导致项目延期" },
  { hookId: "H007", beatTag: "ch19-h1", plantedChapter: 19, type: "信息差", timing: "near-term", core: "隐藏的定时任务接口是历史遗留", expectedPayoff: 25, payoffNote: "危机解除后，初夏正式成为核心骨干，该历史遗留接口的彻底清理为后续接手核心产品线扫清障碍。", notes: "排查中发现的隐藏定时任务接口，似乎并非当前项目代码，而是历史遗留" },
  { hookId: "H008", beatTag: "ch23-h1", plantedChapter: 23, type: "信息差", timing: "immediate", core: "来自‘老领导’的催促未读消息", expectedPayoff: 25, payoffNote: "沈清晏出院后宣布初夏晋升，该消息暗示了高层对沈清晏团队的压力，促使她加速放权与培养初夏。", notes: "沈清晏晕倒前亮起的手机屏幕，是一条来自‘老领导’的催促未读消息" },
  { hookId: "H009", beatTag: "ch26-h1", plantedChapter: 26, type: "信息差", timing: "immediate", core: "底层日志中奇怪的并发锁死标记", expectedPayoff: 29, payoffNote: "初夏连续熬夜排查，证实异常是底层接口并发限制导致的数据丢失，而非产品逻辑问题。", notes: "初夏在底层日志中发现一个奇怪的并发锁死标记，疑似人为遗留" },
  { hookId: "H010", beatTag: "ch28-h1", plantedChapter: 28, type: "威胁", timing: "near-term", core: "边缘成员的离职倾向被竞品利用", expectedPayoff: 33, payoffNote: "竞品见挖角不成，联合外部渠道散布谣言，被利用的边缘成员成为帮凶。", notes: "竞品挖角时，特意提到了初夏团队中一个边缘成员的离职倾向" },
  { hookId: "H011", beatTag: "ch30-h1", plantedChapter: 30, type: "秘密", timing: "mid-arc", core: "沈清晏左手腕的旧疤", expectedPayoff: 44, payoffNote: "沈清晏家中突发停电，两人在黑暗中分享对失控的恐惧，旧疤的来历被彻底揭开。", notes: "沈清晏试图接管时，手不自觉地摩挲着左手腕的一道旧疤" },
  { hookId: "H012", beatTag: "ch34-h1", plantedChapter: 34, type: "事件", timing: "immediate", core: "未经初夏确认的预算超支报表", expectedPayoff: 36, payoffNote: "沈清晏在会议中暗中抛出底牌，指出报表数据口径错误，轻描淡写地扛下所有压力。", notes: "陆远发难时，手里拿着一份未经初夏确认的预算超支报表" },
];

const REAL_BOARD: readonly ThreadBoardState[] = [
  { lineId: "M", status: "进行中", currentEvent: "E-M01", nextEvent: "E-M02", waitingFor: [], estimatedWake: "林初夏完成首个小项目攻坚，与沈清晏初步破冰建立信任。" },
  { lineId: "S1", status: "进行中", currentEvent: "E-S101", nextEvent: "E-S102", waitingFor: ["E-M03"], estimatedWake: "核心产品上线后数据异常，沈清晏创伤应激试图过度干预，林初夏用数据证明自己能兜底。" },
];

const REAL_FACTS: readonly WorkspaceFact[] = [
  { subject: "林初夏", predicate: "位置/身份/情绪/认知/资源", value: "公司办公区/入职报到区｜新入职的产品部初级专员｜忐忑、期待，暗藏对沦为平庸螺丝钉的焦虑｜知道沈清晏是出了名的冷面严苛总监；不知道沈清晏早年的心理创伤及严苛背后的深层原因。｜微薄的新人薪资，满腔热血与死磕精神，尚未积累职场人脉。" },
  { subject: "沈清晏", predicate: "位置/身份/情绪/认知/资源", value: "总监独立办公室｜产品部总监｜冷静、克制，内心潜藏对失去掌控感的隐忧｜知道林初夏是缺乏经验的新人需要打磨；不知道林初夏内心对平庸的极度恐惧，也不知道她背后默默死磕的程度。｜部门管理权、行业顶尖的专业能力、过往积累的行业资源与人脉。" },
  { subject: "陆远", predicate: "位置/身份/情绪/认知/资源", value: "业务部办公区｜业务部负责人/跨部门协同者｜务实、精明，带着KPI导向的压迫感｜知道产品部当前的KPI压力与资源诉求；不知道沈清晏和林初夏的私人感情进展，不知晓研发底层的具体技术瓶颈细节。｜业务预算分配建议权、跨部门博弈的筹码与数据报表。" },
  { subject: "林初夏+沈清晏", predicate: "关系/信任/知情", value: "上下级/师徒（初期）｜极低（仅停留在职场表面的敬畏与试探）｜林初夏不知道沈清晏的心理创伤；沈清晏不知道林初夏对平庸的恐惧。" },
  { subject: "沈清晏+陆远", predicate: "关系/信任/知情", value: "跨部门协同/资源博弈者｜表面合作，暗中防备（基于KPI与资源的博弈）｜陆远不知道沈清晏的心理创伤；沈清晏知道陆远只看重短期KPI而私下认可产品能力。" },
  { subject: "林初夏+陆远", predicate: "关系/信任/知情", value: "业务对接人/跨部门协作｜陌生（尚未建立实质性信任）｜林初夏不知道陆远私下认可产品团队；陆远不知道林初夏的死磕精神与潜力。" },
  { subject: "世界", predicate: "时间", value: "当代·初夏" },
  { subject: "世界", predicate: "地点", value: "某一线互联网大厂" },
  { subject: "世界", predicate: "行业环境", value: "互联网产品竞争白热化，流量红利见顶，竞品恶意挖角与价格战频发。" },
  { subject: "世界", predicate: "公司现状", value: "核心产品面临增长瓶颈，跨部门KPI博弈激烈，资源分配寸土必争。" },
  { subject: "世界", predicate: "公众认知", value: "外界不知道沈清晏早年的心理创伤，也不知道林初夏的潜力与死磕精神。" },
];

/** 节拍板：覆盖全部 12 个 seed 的埋设章（threadId 为真实归属），另含 1 个无埋设章。 */
const REAL_BEATS: readonly BeatIntentionsBeat[] = [
  { chapter: 1, title: "冷面总监与菜鸟入职", mainBeat: "林初夏入职第一天", characters: [{ name: "林初夏", action: "办理入职" }, { name: "沈清晏", action: "布置高压任务" }], threadId: "M", pacing: "铺垫", emotionalArc: "期待→忐忑", hookIntentions: ["【ch1-h1】沈清晏办公桌角落倒扣着一个边缘磨损的旧相框，她严禁任何人触碰"], plannedPayoffOf: [] },
  { chapter: 2, title: "第一份方案的溃败", mainBeat: "方案被全盘推翻", characters: [{ name: "林初夏", action: "强忍尴尬" }, { name: "沈清晏", action: "打回方案" }], threadId: "M", pacing: "上升", emotionalArc: "自信→受挫", hookIntentions: [], plannedPayoffOf: [] },
  { chapter: 3, title: "深夜的自我怀疑", mainBeat: "林初夏熬夜改方案", characters: [{ name: "林初夏", action: "对着满屏修改痕迹发呆" }], threadId: "M", pacing: "紧张", emotionalArc: "焦虑→暗燃", hookIntentions: ["【ch3-h1】林初夏在查阅底层数据时，发现一个被忽略的长尾用户活跃度异常波动"], plannedPayoffOf: [] },
  { chapter: 6, title: "复盘间隙", mainBeat: "陆远提及上季度延期", characters: [{ name: "陆远", action: "提及延期" }, { name: "沈清晏", action: "眼神微变" }], threadId: "M", pacing: "铺垫", emotionalArc: "平静→波动", hookIntentions: ["【ch6-h1】陆远提及‘上季度延期’时，沈清晏眼神微变，手指无意识地摩挲着笔杆"], plannedPayoffOf: [] },
  { chapter: 8, title: "深夜的报错代码", mainBeat: "沈清晏发火盯着报错代码", characters: [{ name: "沈清晏", action: "盯着报错代码" }], threadId: "S1", pacing: "紧张", emotionalArc: "克制→爆发", hookIntentions: ["【ch8-h1】沈清晏发火时，死死盯着屏幕上的一串特定报错代码，仿佛看到了某种可怕的梦魇"], plannedPayoffOf: [] },
  { chapter: 12, title: "权限设置之争", mainBeat: "被叫停的权限设置", characters: [{ name: "林初夏", action: "坚持己见" }, { name: "陆远", action: "叫停设置" }], threadId: "M", pacing: "紧张", emotionalArc: "坚定→受挫", hookIntentions: ["【ch12-h1】被叫停的那处权限设置，看似无关紧要，实则涉及核心数据隔离"], plannedPayoffOf: [] },
  { chapter: 16, title: "开发主管的抱怨", mainBeat: "开发主管抱怨沈清晏死磕细节", characters: [{ name: "林初夏", action: "旁听" }], threadId: "M", pacing: "铺垫", emotionalArc: "平静→若有所思", hookIntentions: ["【ch16-h1】开发主管抱怨时提到，沈清晏早年也曾为了一个细节死磕导致项目延期"], plannedPayoffOf: [] },
  { chapter: 19, title: "隐藏的定时任务", mainBeat: "排查发现历史遗留接口", characters: [{ name: "林初夏", action: "排查接口" }, { name: "沈清晏", action: "远程指导" }], threadId: "M", pacing: "紧张", emotionalArc: "困惑→明朗", hookIntentions: ["【ch19-h1】排查中发现的隐藏定时任务接口，似乎并非当前项目代码，而是历史遗留"], plannedPayoffOf: [] },
  { chapter: 23, title: "沈清晏晕倒", mainBeat: "晕倒前亮起的手机屏幕", characters: [{ name: "沈清晏", action: "晕倒" }], threadId: "S1", pacing: "紧张", emotionalArc: "紧绷→崩溃", hookIntentions: ["【ch23-h1】沈清晏晕倒前亮起的手机屏幕，是一条来自‘老领导’的催促未读消息"], plannedPayoffOf: [] },
  { chapter: 26, title: "并发锁死标记", mainBeat: "初夏发现底层日志异常", characters: [{ name: "林初夏", action: "熬夜排查" }], threadId: "M", pacing: "紧张", emotionalArc: "执着→证实", hookIntentions: ["【ch26-h1】初夏在底层日志中发现一个奇怪的并发锁死标记，疑似人为遗留"], plannedPayoffOf: [] },
  { chapter: 28, title: "竞品挖角", mainBeat: "竞品提及边缘成员离职倾向", characters: [{ name: "陆远", action: "提供情报" }], threadId: "M", pacing: "上升", emotionalArc: "平静→警惕", hookIntentions: ["【ch28-h1】竞品挖角时，特意提到了初夏团队中一个边缘成员的离职倾向"], plannedPayoffOf: [] },
  { chapter: 30, title: "旧疤", mainBeat: "沈清晏试图接管，摩挲旧疤", characters: [{ name: "沈清晏", action: "摩挲旧疤" }, { name: "林初夏", action: "察觉异常" }], threadId: "S1", pacing: "铺垫", emotionalArc: "克制→波动", hookIntentions: ["【ch30-h1】沈清晏试图接管时，手不自觉地摩挲着左手腕的一道旧疤"], plannedPayoffOf: [] },
  { chapter: 34, title: "预算超支报表", mainBeat: "陆远发难，报表口径错误", characters: [{ name: "陆远", action: "发难" }, { name: "沈清晏", action: "暗中抛底牌" }], threadId: "M", pacing: "紧张", emotionalArc: "压抑→反击", hookIntentions: ["【ch34-h1】陆远发难时，手里拿着一份未经初夏确认的预算超支报表"], plannedPayoffOf: [] },
];

const REAL_CHARACTER_CARDS: readonly CharacterCardLike[] = [
  { name: "林初夏", tier: "S", archetype: "坚韧成长的职场新人", traits: ["坚韧乐观", "死磕精神", "温暖直率", "极度恐惧平庸"], speechStyle: "直率坦诚，带着新人的冲劲与真诚，偶尔带点自嘲，面对专业质疑时不卑不亢、用数据说话。", secret: "极度害怕自己最终只能做一个平庸的螺丝钉，表面的乐观和死磕实则是对“无法独当一面”的深深焦虑与自我防御。", knowledgeBoundary: ["不知道沈清晏早年项目流产的心理创伤（第二卷末才逐渐察觉）", "不知道沈清晏在跨部门甩锅时暗中为她扛下压力的具体细节（需通过第三方或事后复盘才知晓）"], relationships: [{ name: "沈清晏", relation: "上司/导师/恋人" }] },
  { name: "沈清晏", tier: "S", archetype: "外冷内热的严苛导师", traits: ["雷厉风行", "外冷内热", "工作狂", "极度恐惧失去掌控感"], speechStyle: "简明扼要，直击痛点，不带多余情绪，专业术语多；批评时一针见血，保护时轻描淡写。", secret: "早年因不可控外部因素导致核心项目流产，留下了严重的心理创伤，导致她现在极度害怕失去掌控感，对细节要求苛刻到近乎偏执。", knowledgeBoundary: ["不知道林初夏内心对平庸的极度恐惧（第三卷深谈时才知晓）", "不知道林初夏在背后为了补齐技术短板熬了多少个通宵（直到看到她的体检报告或代码提交记录）"], relationships: [{ name: "林初夏", relation: "下属/徒弟/恋人" }] },
  { name: "陆远", tier: "A", archetype: "结果导向的业务协同者", traits: ["精明务实", "KPI导向", "就事论事"], speechStyle: "数据驱动，喜欢用ROI和转化率说话，沟通时直奔利益点，不带个人情绪。", secret: "其实非常认可沈清晏团队的产品能力，但在跨部门会议上为了自己部门的KPI必须表现出强势争取资源，私下常帮产品团队打掩护。", knowledgeBoundary: ["不知道沈清晏和林初夏的私人感情进展", "不知道产品研发部内部的具体技术瓶颈细节"], relationships: [{ name: "沈清晏", relation: "跨部门协同/资源博弈者" }, { name: "林初夏", relation: "业务对接人" }] },
];

const REAL_STATE0_STATES: readonly State0CharacterState[] = [
  { name: "林初夏", location: "公司办公区/入职报到区", identity: "新入职的产品部初级专员", emotion: "忐忑、期待，暗藏对沦为平庸螺丝钉的焦虑", cognition: "知道沈清晏是出了名的冷面严苛总监；不知道沈清晏早年的心理创伤及严苛背后的深层原因。", resources: "微薄的新人薪资，满腔热血与死磕精神，尚未积累职场人脉。" },
  { name: "沈清晏", location: "总监独立办公室", identity: "产品部总监", emotion: "冷静、克制，内心潜藏对失去掌控感的隐忧", cognition: "知道林初夏是缺乏经验的新人需要打磨；不知道林初夏内心对平庸的极度恐惧，也不知道她背后默默死磕的程度。", resources: "部门管理权、行业顶尖的专业能力、过往积累的行业资源与人脉。" },
  { name: "陆远", location: "业务部办公区", identity: "业务部负责人/跨部门协同者", emotion: "务实、精明，带着KPI导向的压迫感", cognition: "知道产品部当前的KPI压力与资源诉求；不知道沈清晏和林初夏的私人感情进展，不知晓研发底层的具体技术瓶颈细节。", resources: "业务预算分配建议权、跨部门博弈的筹码与数据报表。" },
];

const REAL_THREAD_MAP_LINES = [
  { id: "M", name: "职场蜕变与双向奔赴主线", goal: "林初夏从菜鸟成长为顶尖产品总监，并与沈清晏实现势均力敌的双向奔赴。", events: [
    { id: "E-M01", content: "林初夏入职，方案被沈清晏反复打回，经历严苛打磨，展现新人的笨拙与韧性。", volume: "第一卷", requires: [], merge: false },
    { id: "E-M02", content: "首个小项目攻坚，林初夏死磕细节，沈清晏深夜复盘指导，两人初步破冰建立信任。", volume: "第一卷", requires: ["E-M01"], merge: false },
  ] },
  { id: "S1", name: "职场危机与创伤暗线", goal: "沈清晏的创伤应激在项目危机中被触发，林初夏用实力证明自己能兜底。", events: [
    { id: "E-S101", content: "核心产品上线后数据异常，沈清晏创伤应激试图过度干预。", volume: "第二卷", requires: ["E-M02"], merge: false },
  ] },
];

/* ---------------- 纯映射函数测试 ---------------- */

test("mapBookConfig：运行参数直传（platform 保留原文「晋江文学城」）", () => {
  const config = mapBookConfig(REAL_INK);
  assert.equal(config.bookId, "chuxiafengqingyan");
  assert.equal(config.platform, "晋江文学城");
  assert.equal(config.targetChapters, 100);
  assert.equal(config.chapterWordCount, 3000);
  assert.equal(config.chapterReviewMode, "auto");
  assert.equal(config.maxHookRetries, 2);
});

test("mapHookLedger：12 条种子 → 账本；初始全 open；core 非空 → coreHook；「事件」类型被词表接受", () => {
  const ledger = mapHookLedger(REAL_SEEDS);
  assert.equal(Object.keys(ledger).length, 12);
  for (const seed of REAL_SEEDS) {
    const record = ledger[seed.hookId as HookId];
    assert.equal(record.status, "open", `${seed.hookId} 初始应 open`);
    assert.equal(record.lastAdvancedChapter, 0, `${seed.hookId} 未推进`);
    assert.equal(record.advancedCount, 0);
    assert.equal(record.startChapter, seed.plantedChapter);
    assert.equal(record.payoffTiming, seed.timing as "slow-burn");
    assert.equal(record.expectedPayoff, seed.payoffNote);
    assert.equal(record.coreHook, seed.core.trim() !== "");
    assert.equal(record.notes, seed.notes);
  }
  // 词表扩充后「事件」类型合法（真实书 H005/H012）
  assert.equal(ledger["H005" as HookId]!.type, "事件");
  assert.equal(ledger["H012" as HookId]!.type, "事件");
  // core 全非空 → 全部 coreHook
  for (const id of ["H001", "H004", "H008", "H011"] as const) {
    assert.equal(ledger[id as HookId]!.coreHook, true);
  }
});

test("mapHookToThread：节拍板反推伏笔→线归属，12 条全覆盖；S1 线含 H004/H008/H011", () => {
  const map = mapHookToThread(REAL_SEEDS, REAL_BEATS);
  assert.equal(Object.keys(map).length, 12, "全部 seed 都应在节拍板找到埋设章");
  assert.equal(map["H001" as HookId], "M");
  assert.equal(map["H005" as HookId], "M");
  assert.equal(map["H012" as HookId], "M");
  assert.equal(map["H004" as HookId], "S1");
  assert.equal(map["H008" as HookId], "S1");
  assert.equal(map["H011" as HookId], "S1");
});

test("mapThreads：线状态/类型/优先级/事件链/角色反推", () => {
  const threads = mapThreads(REAL_BOARD, REAL_THREAD_MAP_LINES, REAL_BEATS);
  assert.equal(threads.length, 2);

  const main = threads.find((t) => t.threadId === "M")!;
  assert.equal(main.kind, "main");
  assert.equal(main.status, "active");
  assert.equal(main.priority, 10);
  assert.equal(main.speed, 1);
  assert.equal(main.title, "职场蜕变与双向奔赴主线");
  assert.deepEqual(main.eventChain.map((e) => e.eventId), ["E-M01", "E-M02"]);
  assert.equal(main.eventChain[0]!.status, "pending");
  assert.equal(main.eventChain[0]!.chapter, null, "小说流事件无章节数值 → null（canReach 依赖线时钟）");
  assert.equal(main.eventChain[1]!.prerequisiteEventIds.includes("E-M01" as EventId), true);
  assert.ok(main.characters.includes("林初夏" as CharacterName), "M 线角色从节拍板反推");
  assert.ok(main.characters.includes("沈清晏" as CharacterName));

  const side = threads.find((t) => t.threadId === "S1")!;
  assert.equal(side.kind, "side");
  assert.equal(side.status, "active");
  assert.equal(side.priority, 5);
  assert.equal(side.speed, 0.3);
  assert.equal(side.eventChain[0]!.eventId, "E-S101");
  assert.ok(side.characters.includes("沈清晏" as CharacterName), "S1 线角色从节拍板反推");
});

test("mapFacts：压缩三元组 → Fact；subjectType 按形状推导", () => {
  const facts = mapFacts(REAL_FACTS);
  assert.equal(facts.length, 11);
  assert.equal(facts[0]!.subject, "林初夏");
  assert.equal(facts[0]!.subjectType, "character");
  assert.equal(facts[0]!.factId, "F001");
  assert.equal(facts[3]!.subjectType, "relationship");
  assert.equal(facts[6]!.subjectType, "world");
  for (const f of facts) {
    assert.equal(f.validFromChapter, 1);
    assert.equal(f.validUntilChapter, null);
    assert.equal(f.sourceChapter, 1);
    assert.equal(f.status, "active");
    assert.ok(f.object.length > 0, "压缩 value 原样保留（信息不丢失）");
  }
});

test("mapCharacters：N5 角色卡 → 章节流 CharacterCard（goals/fears/aliases 初始空，relationship 补 desc）", () => {
  const cards = mapCharacters(REAL_CHARACTER_CARDS, REAL_BEATS);
  assert.equal(cards.length, 3);
  const qingyan = cards.find((c) => c.name === "沈清晏")!;
  assert.equal(qingyan.tier, "S");
  assert.ok(qingyan.traits.includes("雷厉风行"));
  assert.ok(qingyan.secret.includes("项目流产"));
  assert.equal(qingyan.knowledgeBoundary.length, 2);
  assert.deepEqual(qingyan.goals, []);
  assert.deepEqual(qingyan.fears, []);
  assert.deepEqual(qingyan.aliases, []);
  assert.equal(qingyan.relationships[0]!.target, "林初夏");
  assert.equal(qingyan.relationships[0]!.type, "下属/徒弟/恋人");
  assert.equal(qingyan.relationships[0]!.desc, "下属/徒弟/恋人");
});

test("mapCharacters：缺 N5 时用节拍板角色名兜底（最小卡）", () => {
  const cards = mapCharacters(undefined, REAL_BEATS);
  assert.ok(cards.length >= 3, "从节拍板去重反推角色名");
  assert.ok(cards.some((c) => c.name === "林初夏"));
  assert.ok(cards.every((c) => c.tier === "B" && c.goals.length === 0));
});

test("mapCharacterStates：N6 结构化状态 → 章节流 CharacterState（无来源字段初始空）", () => {
  const states = mapCharacterStates(REAL_STATE0_STATES);
  assert.equal(Object.keys(states).length, 3);
  const chuxia = states["林初夏" as CharacterName]!;
  assert.equal(chuxia.location, "公司办公区/入职报到区");
  assert.ok(chuxia.emotion.includes("忐忑"));
  assert.equal(chuxia.goal, "", "小说流产物无 goal → 初始空（随 settle 建立）");
  assert.deepEqual(chuxia.knows, []);
  assert.deepEqual(chuxia.suspects, []);
  assert.deepEqual(chuxia.inventory, []);
  assert.deepEqual(chuxia.bonds, {});
});

/* ---------------- 端到端：写临时书目录 → 构建运行时 ---------------- */

function writeFixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "book-workspace-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "story", "beats"), { recursive: true });
  writeFileSync(join(dir, "inkos.json"), JSON.stringify({ ...REAL_INK, platformProfile: { hook: { maxActive: 12 } } }));
  writeFileSync(join(dir, "state", "hooks.json"), JSON.stringify({ bookId: "chuxiafengqingyan", hooks: REAL_SEEDS, archive: [] }));
  writeFileSync(join(dir, "state", "threads.json"), JSON.stringify({ bookId: "chuxiafengqingyan", threadBoard: REAL_BOARD }));
  writeFileSync(join(dir, "state", "facts.json"), JSON.stringify({ bookId: "chuxiafengqingyan", facts: REAL_FACTS }));
  writeFileSync(join(dir, "story", "beats", "beats.json"), JSON.stringify({ beats: REAL_BEATS }));
  return dir;
}

test("端到端：buildRuntimeFromBookWorkspace（无 N5/N6 时降级；运行时可直接 settle）", () => {
  const dir = writeFixtureWorkspace();
  try {
    const runtime = buildRuntimeFromBookWorkspace(dir, { artifactsRoot: dir });
    assert.equal(runtime.config.platform, "晋江文学城");
    assert.equal(Object.keys(runtime.ledgerView).length, 12);

    // chapter=1：全新书无强制指令；coreHook 全在 mustNotDefer
    const ctx1 = runtime.ledger.viewForChapter(1);
    assert.deepEqual(ctx1.mustResolve, []);
    assert.deepEqual(ctx1.mustAdvance, []);
    assert.equal(ctx1.budget.activeCount, 12);
    assert.equal(ctx1.budget.cap, 12);
    assert.equal(ctx1.mustNotDefer.length, 12, "真实书 core 全非空 → 全部不可 defer");

    // settle 空 delta：applied；线时钟推进（M/S1 均 active → 推进到 1）
    const result = runtime.settleChapter(1, { hookOps: [], facts: [], stateChanges: {} });
    assert.equal(result.kind, "applied");
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.threads.find((t) => t.threadId === "M")!.syncPoint, 1);
    assert.equal(snapshot.threads.find((t) => t.threadId === "S1")!.syncPoint, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("端到端：带 N5/N6 补源（真实衔接场景——书目录 + architecture + state0 产物）", () => {
  const dir = writeFixtureWorkspace();
  const n5 = join(dir, "architecture.json");
  const n6 = join(dir, "state0.json");
  writeFileSync(n5, JSON.stringify({ bookId: "chuxiafengqingyan", characterCards: REAL_CHARACTER_CARDS, threadMap: { lines: REAL_THREAD_MAP_LINES } }));
  writeFileSync(n6, JSON.stringify({ bookId: "chuxiafengqingyan", characterStates: REAL_STATE0_STATES }));
  try {
    const runtime = buildRuntimeFromBookWorkspace(dir, { architecturePath: n5, state0Path: n6 });
    assert.equal(runtime.characters.length, 3);
    assert.equal(runtime.characterStates["林初夏" as CharacterName]!.location, "公司办公区/入职报到区");
    assert.equal(runtime.characterStates["林初夏" as CharacterName]!.emotion.includes("忐忑"), true);
    // 角色卡 secret 进入运行时（direct prompt 可引用）
    assert.ok(runtime.characters.find((c) => c.name === "沈清晏")!.secret.includes("心理创伤"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
