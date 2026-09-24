import { Beat, BeatBoard, Pacing, StoryArchitecture } from "./types";

/**
 * 演示/测试用：预置《隐龙》五件套。
 * 节拍板为 100 章（与示例书 targetChapters 一致），由真实示例章节（ch1-ch3）+
 * 程序生成的合法占位章构成，保证通过验收闸门（mainBeat ≤60 字 / 密度 0.2–0.5 / 每条伏笔有回收 / 相邻 3 章不全释放）。
 */

/** ch1-ch3 真实示例章（文档 ch2 原版 + 自造首尾章）。 */
const EXAMPLE_OPENING_BEATS: Beat[] = [
  {
    chapter: 1,
    title: "入赘",
    mainBeat: "龙王殿殿主叶凡隐姓埋名入赘江家，对外身份是江氏贸易小职员",
    characters: [
      { name: "叶凡", action: "收敛锋芒，以赘婿身份入住岳母家客房" },
      { name: "苏晴", action: "冷淡应对，只当他是认命的上门女婿" },
    ],
    threadId: "M",
    pacing: "铺垫",
    emotionalArc: "隐忍→暗涌",
    hookIntentions: [],
    plannedPayoffOf: [],
  },
  {
    chapter: 2,
    title: "最后通牒",
    mainBeat: "岳母逼叶凡签下离婚协议，附条件：三个月内拿不出百万证明就办手续",
    characters: [
      { name: "叶凡", action: "签得极爽快，签完把纸抚平放回抽屉，没丢" },
      { name: "苏晴", action: "想拦，被母亲一句'你爸留下的房子'堵回去" },
      { name: "赵芳", action: "拿协议当武器，逐条念羞辱条款" },
    ],
    threadId: "M",
    pacing: "上升",
    emotionalArc: "屈辱→暗燃",
    hookIntentions: [
      "【ch2-h1】协议要留下物理特征：签完后被抚平但留四道折痕——后面要用",
      "【ch2-h2】叶凡爽快得不正常，读者要觉得'他有底气'但说不出为什么",
    ],
    plannedPayoffOf: [],
  },
  {
    chapter: 3,
    title: "旧部暗涌",
    mainBeat: "老陈带着一瓶不摘标签的酒上门，与叶凡在暗处核对灭门夜旧事",
    characters: [
      { name: "老陈", action: "递酒时不摘标签，话里话外试探殿主还记得多少" },
      { name: "叶凡", action: "接过酒，只说了一句'那天的事，我记得'，不再多言" },
    ],
    threadId: "S1",
    pacing: "紧张",
    emotionalArc: "试探→确认",
    hookIntentions: [],
    plannedPayoffOf: [],
  },
];

/** 占位章的 pacing 周期（周期 10，任意相邻 3 章不全为「释放」）。 */
const PLACEHOLDER_PACING_CYCLE: Pacing[] = ["铺垫", "上升", "紧张", "舒缓", "上升", "铺垫", "紧张", "上升", "舒缓", "铺垫"];

/** 固定安排「释放」的章（间隔远，避免 3 连）。 */
const RELEASE_CHAPTERS = new Set([20, 50, 80, 100]);

/** 程序生成合法占位章：每 4 章埋一条伏笔（ch4-h1、ch8-h1…ch88-h1），并在 chN+12 回收。 */
function buildPlaceholderBeats(totalChapters: number): Beat[] {
  const beats: Beat[] = [];
  for (let chapter = 4; chapter <= totalChapters; chapter += 1) {
    const cycleIndex = (chapter - 4) % PLACEHOLDER_PACING_CYCLE.length;
    const pacing: Pacing = RELEASE_CHAPTERS.has(chapter) ? "释放" : PLACEHOLDER_PACING_CYCLE[cycleIndex];
    const hookIntentions: string[] = [];
    const plannedPayoffOf: string[] = [];
    // 真实示例章 ch2 的两条伏笔：ch21 回收折痕协议、ch58 回收"爽快得不正常"
    if (chapter === 21) {
      plannedPayoffOf.push("ch2-h1");
    }
    if (chapter === 58) {
      plannedPayoffOf.push("ch2-h2");
    }
    // 占位伏笔：每 4 章埋一条，且在总章数范围内安排回收（chapter+12 ≤ 总章数才埋）
    if (chapter % 4 === 0 && chapter + 12 <= totalChapters) {
      hookIntentions.push(`【ch${chapter}-h1】第 ${chapter} 章埋设的占位伏笔：本章细节留作后续回收`);
    }
    if (chapter > 4 && (chapter - 12) % 4 === 0) {
      plannedPayoffOf.push(`ch${chapter - 12}-h1`);
    }
    beats.push({
      chapter,
      title: `第${chapter}章`,
      mainBeat: `推进主线：围绕叙事线 ${chapter % 3 === 0 ? "S1" : "M"} 的当前事件展开本章冲突`,
      characters: [{ name: "叶凡", action: "推进当前事件" }],
      threadId: chapter % 3 === 0 ? "S1" : "M",
      pacing,
      emotionalArc: "推进",
      hookIntentions,
      plannedPayoffOf,
    });
  }
  return beats;
}

/** 构建《隐龙》100 章节拍板：ch1-ch3 真实示例 + ch4 起占位。 */
function buildExampleBeatBoard(totalChapters: number): BeatBoard {
  return { beats: [...EXAMPLE_OPENING_BEATS, ...buildPlaceholderBeats(totalChapters)] };
}

/** 构建《隐龙》五件套（targetChapters=100）。 */
export function buildExampleArchitecture(): StoryArchitecture {
  return {
    bookId: "yinlong",
    title: "隐龙",
    storyFrame: {
      coreStory:
        "龙王殿殿主叶凡隐姓埋名入赘，在应对岳家欺压的同时调查五年前叶家灭门案，并在这个过程中重聚势力、揭开真相。",
      coreConflict: "信息差——「所有人以为他是谁」与「他到底是谁」；复仇线与婚姻认知线并行推进。",
      protagonistPath: ["隐忍入赘", "借势反噬", "势力重聚", "身份揭示", "真相大白"],
    },
    volumeMap: [
      {
        volume: "第一卷",
        title: "离婚协议",
        goal: "完成第一次借势反噬",
        stages: ["岳母逼签", "江家拿协议做文章", "第三条条款反噬江氏分公司"],
      },
      {
        volume: "第二卷",
        title: "重聚",
        goal: "旧部归位",
        stages: ["老陈递酒", "林峰归来", "江辰背后的人浮出水面"],
      },
      {
        volume: "第三卷",
        title: "龙王",
        goal: "身份揭示与灭门真相",
        stages: ["闪回线收束", "身份揭示", "真相大白"],
      },
    ],
    characterCards: [
      {
        name: "叶凡",
        tier: "S",
        archetype: "protagonist",
        traits: ["对外人惜字如金", "对苏晴克制地温柔", "不做无把握的暴露", "记账式思维"],
        speechStyle: "对外 ≤8 字短句；长句只出现在内心；不用书面语连接词",
        secret: "龙王殿殿主；五年前灭门案唯一幸存者；离婚协议第三条是他自己拟的",
        knowledgeBoundary: [
          "不知道父亲当年还留下一份手记（ch45 才揭示）",
          "不知道苏晴已私下雇了私家侦探（ch18 埋，ch36 揭）",
        ],
        relationships: [
          { name: "苏晴", relation: "夫妻，两年未圆房，保护但不解释" },
          { name: "赵芳", relation: "岳母，被嫌弃的一方，从不辩解" },
          { name: "老陈", relation: "旧部/长辈，灭门夜另一个在场者" },
        ],
      },
      {
        name: "苏晴",
        tier: "A",
        archetype: "deuteragonist",
        traits: ["外冷内热", "重情", "对婚姻有隐忍也有底线"],
        speechStyle: "书面、克制，情绪压到句尾",
        secret: "已经开始怀疑叶凡不简单，但没有证据",
        knowledgeBoundary: ["不知道叶凡的真实身份", "不知道灭门案与龙王殿有关"],
        relationships: [
          { name: "叶凡", relation: "挂名丈夫，认知从'废物'分层推进" },
          { name: "赵芳", relation: "母亲，顺从但内心不认同逼婚手段" },
        ],
      },
      {
        name: "赵芳",
        tier: "B",
        archetype: "antagonist-support",
        traits: ["势利", "嘴利", "把体面看得比亲情重"],
        speechStyle: "用羞辱性短句和条款式威胁",
        secret: "无（所有算计都摆在台面上）",
        knowledgeBoundary: ["不知道叶凡真实身份", "不知道离婚协议第三条的用意"],
        relationships: [
          { name: "叶凡", relation: "女婿，嫌弃并逼离婚" },
          { name: "苏晴", relation: "女儿，以'为你好'之名操控" },
        ],
      },
      {
        name: "老陈",
        tier: "A",
        archetype: "mentor",
        traits: ["忠诚", "寡言", "记得所有旧部名单"],
        speechStyle: "酒桌式慢语，话里有话",
        secret: "灭门夜他在场，知道叶凡当时左臂中刀",
        knowledgeBoundary: ["不知道离婚协议第三条是叶凡拟的"],
        relationships: [
          { name: "叶凡", relation: "旧部/长辈，效忠并守护" },
        ],
      },
    ],
    threadMap: {
      lines: [
        {
          id: "M",
          name: "主线：叶凡查灭门案",
          goal: "从「隐忍入赘」到「身份揭示与真相大白」",
          events: [
            { id: "E-M01", content: "离婚协议逼签", volume: "第1卷", requires: [], merge: false },
            { id: "E-M02", content: "江氏董事会借势反噬", volume: "第1卷", requires: ["E-M01"], merge: false },
            { id: "E-M03", content: "苏晴怀疑加深", volume: "第1卷", requires: ["E-M02"], merge: false },
            { id: "E-M04", content: "林峰接手江氏分公司", volume: "第2卷", requires: ["E-M02"], merge: false },
            { id: "E-M05", content: "身份揭示", volume: "第3卷", requires: ["E-S103", "E-F103"], merge: true },
          ],
        },
        {
          id: "S1",
          name: "分线：龙王殿线（旧部重聚）",
          goal: "老陈、林峰逐步回到叶凡身边",
          events: [
            { id: "E-S101", content: "老陈递上不摘标签的酒", volume: "第1卷", requires: ["E-M02"], merge: false },
            { id: "E-S102", content: "林峰归来，接手对外事务", volume: "第2卷", requires: ["E-S101"], merge: false },
            { id: "E-S103", content: "龙王殿旧部重聚", volume: "第2卷", requires: ["E-S102", "E-M04"], merge: true },
          ],
        },
        {
          id: "F1",
          name: "闪回线：五年前的雨夜",
          goal: "逐段还原灭门夜全貌",
          events: [
            { id: "E-F101", content: "灭门夜开始", volume: "第1卷", requires: ["E-M01"], merge: false },
            { id: "E-F102", content: "叶凡回家，进屋之前", volume: "第2卷", requires: ["E-F101"], merge: false },
            { id: "E-F103", content: "进屋之后的真相", volume: "第3卷", requires: ["E-F102"], merge: false },
          ],
        },
      ],
    },
    beatBoard: buildExampleBeatBoard(100),
  };
}

/** 预置五件套对象。 */
export const EXAMPLE_ARCHITECTURE: StoryArchitecture = buildExampleArchitecture();

/** 预置五件套 JSON（供 MemoryModel 返回）。 */
export const EXAMPLE_ARCHITECTURE_JSON: string = JSON.stringify(EXAMPLE_ARCHITECTURE, null, 2);

/** 预置节拍板 JSON（Director 的 MemoryModel 响应，根结构为 { beats }）。 */
export const EXAMPLE_BEAT_BOARD_JSON: string = JSON.stringify({ beats: EXAMPLE_ARCHITECTURE.beatBoard.beats }, null, 2);
