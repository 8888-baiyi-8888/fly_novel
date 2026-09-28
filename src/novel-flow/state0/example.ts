import { State0 } from "./types";

/** 预置《隐龙》State0（六类，与工作流文档 N6 示例一致）。 */
export function buildExampleState0(): State0 {
  return {
    bookId: "yinlong",
    title: "隐龙",
    characterStates: [
      {
        name: "叶凡",
        location: "江家·岳母家客房",
        identity: "江氏贸易小职员（公开身份）",
        emotion: "克制",
        cognition: "知道自己的真实身份与灭门案内情；知道离婚协议第三条是自己拟的",
        resources: "月薪八千",
      },
      {
        name: "苏晴",
        location: "江家主卧",
        identity: "江氏品牌部职员",
        emotion: "疲惫",
        cognition: "不知道叶凡真实身份，以为他认命了",
        resources: "江氏品牌部职员薪资",
      },
      {
        name: "赵芳",
        location: "江家客厅",
        identity: "江家岳母",
        emotion: "筹谋",
        cognition: "认定叶凡没出息，正在筹谋逼离婚",
        resources: "江家房产与话语权",
      },
      {
        name: "老陈",
        location: "城中村酒馆",
        identity: "退休酒馆老板（表面）",
        emotion: "隐忍",
        cognition: "知道叶凡真实身份；知道灭门夜自己也在场",
        resources: "一间酒馆",
      },
    ],
    relationshipStates: [
      {
        subjects: ["叶凡", "苏晴"],
        relation: "挂名夫妻",
        trust: "低",
        knowledge: "苏晴不知叶凡真实身份",
      },
      {
        subjects: ["叶凡", "赵芳"],
        relation: "岳母女婿",
        trust: "极低",
        knowledge: "赵芳正在筹谋逼离婚",
      },
      {
        subjects: ["叶凡", "老陈"],
        relation: "旧部/长辈",
        trust: "极高",
        knowledge: "双方都知道对方在灭门夜在场",
      },
    ],
    worldState: [
      { key: "时间", value: "当代·春季" },
      { key: "龙王殿活跃程度", value: "低（殿主隐匿）" },
      { key: "江氏贸易", value: "扩张期" },
      { key: "公众是否知道龙王殿存在", value: "否" },
      { key: "叶家灭门案", value: "已结案五年，无人再查" },
    ],
    hookSeeds: [
      {
        hookId: "H001",
        beatTag: "ch4-h1",
        plantedChapter: 1,
        type: "能力",
        timing: "near-term",
        core: "叶凡身手",
        expectedPayoff: 4,
        payoffNote: "ch4 暴露部分身手",
        notes: "三秒放倒三人，戴口罩，左手虎口有茧",
      },
      {
        hookId: "H007",
        beatTag: "ch2-h1",
        plantedChapter: 2,
        type: "物件",
        timing: "mid-arc",
        core: "离婚协议",
        expectedPayoff: 21,
        payoffNote: "ch21 对赌条款反噬江氏",
        notes: "签完把纸抚平放回抽屉最底层，四道折痕",
      },
      {
        hookId: "H011",
        beatTag: "ch2-h2",
        plantedChapter: 5,
        type: "秘密",
        timing: "slow-burn",
        core: "老陈在灭门夜在场",
        expectedPayoff: 58,
        payoffNote: "ch58 灭门夜他在场",
        notes: "老陈每晚喝一瓶不摘标签的酒",
      },
      {
        hookId: "H014",
        beatTag: "ch68-h1",
        plantedChapter: 6,
        type: "事件",
        timing: "endgame",
        core: "灭门夜真相",
        expectedPayoff: 80,
        payoffNote: "ch80 真相",
        notes: "雨夜，叶凡左臂中刀，父亲在他面前停止呼吸",
      },
      {
        hookId: "H019",
        beatTag: "ch16-h1",
        plantedChapter: 16,
        type: "威胁",
        timing: "near-term",
        core: "",
        expectedPayoff: 24,
        payoffNote: "ch24 反派背后的人现身",
        notes: "反派第二次来电时把手机屏幕朝下",
      },
    ],
    threadBoard: [
      {
        lineId: "M",
        status: "进行中",
        currentEvent: null,
        nextEvent: "E-M01",
        waitingFor: [],
        estimatedWake: "ch1 离婚协议逼签",
      },
      {
        lineId: "S1",
        status: "冷藏",
        currentEvent: null,
        nextEvent: "E-S101",
        waitingFor: ["E-M02 完成"],
        estimatedWake: "ch21 左右（老陈递酒）",
      },
      {
        lineId: "F1",
        status: "冷藏",
        currentEvent: null,
        nextEvent: "E-F101",
        waitingFor: ["E-M01 完成"],
        estimatedWake: "ch6 左右（灭门夜首次闪回）",
      },
    ],
    progressState: {
      currentChapter: 0,
      currentVolume: "第一卷",
      stage: "故事开端",
      completedEvents: [],
      nextDirection: "离婚协议逼签",
    },
  };
}

/** 预置 State0 对象。 */
export const EXAMPLE_STATE0: State0 = buildExampleState0();

/** 预置 State0 JSON（供 MemoryModel 返回）。 */
export const EXAMPLE_STATE0_JSON: string = JSON.stringify(EXAMPLE_STATE0, null, 2);
