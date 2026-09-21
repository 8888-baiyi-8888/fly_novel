import { CreativeDraft } from "./types";

/** 演示/测试用：用户原始输入示例（《隐龙》，与工作流文档 N0 一致）。 */
export const EXAMPLE_RAW_INPUT = `我想写一本都市隐龙流小说。主角叶凡，表面上是上门女婿，在江氏贸易当小职员，
其实是龙王殿殿主，掌控着一张离岸资金网。他入赘是为了查五年前叶家的灭门案，
他是唯一的幸存者。我想写的是信息差——所有人都以为他是废物，包括他妻子苏晴。
爽点来源不是他多强，而是他每次"轻描淡写的正确"。前期借岳母逼签离婚协议的势
反噬江家，中期重新聚拢旧部势力，最后揭开灭门真相。不要虐主、不要送女、
不要把反派写成无脑降智。目标平台番茄，100 章左右完结。`;

/** 演示/测试用：与 EXAMPLE_DRAFT_JSON 对应的规范化草案对象（《隐龙》，含 N1 全部五类字段，v2 多主角数组）。 */
export const EXAMPLE_DRAFT: CreativeDraft = {
  schemaVersion: 2,
  title: "隐龙",
  genre: ["都市", "隐龙流"],
  platform: "番茄",
  targetChapters: 100,
  chapterWordCount: 2500,
  language: "zh",
  worldPremise:
    "当代都市，江氏贸易是本地龙头企业；龙王殿是离岸世界的传说，公众不知其存在；五年前叶家雨夜灭门案已结案，真相不明。",
  protagonists: [
    {
      name: "叶凡",
      identity: "上门女婿，表面身份江氏贸易小职员，真实身份龙王殿殿主",
      traits: ["谨慎", "克制", "不做无把握的暴露"],
      coreNeed: "查清五年前灭门案真相",
      coreFear: "身份暴露",
    },
  ],
  supportingCast: [
    { name: "苏晴", identity: "江氏品牌部职员", relation: "妻子，不知叶凡真实身份" },
    { name: "赵芳", identity: "岳母", relation: "嫌弃女婿，正在逼离婚" },
    { name: "老陈", identity: "龙王殿旧部/长辈", relation: "旧部，灭门夜另一个在场者" },
    { name: "江辰", identity: "江家反派", relation: "对手" },
  ],
  setting: ["龙王殿是离岸世界的传说，公众不知其存在", "叶家灭门案五年前雨夜发生，已结案，真相不明"],
  coreConflict: "叶凡隐藏身份查灭门案，在江家的欺压与龙王殿事务之间维持平衡",
  blurb: "龙王殿殿主叶凡隐姓埋名入赘，在应对岳家欺压的同时调查五年前的灭门案。",
  authorIntent:
    "核心张力是信息差，爽点来自轻描淡写的正确，不写直接炫力；苏晴对叶凡的认知分层推进，不是工具人。",
  tone: ["信息差", "反差"],
  volumePlan: ["第一卷：借势反噬", "第二卷：势力重聚", "第三卷：真相揭示"],
  currentFocus: ["立起离婚协议伏笔与岳母欺压", "江氏董事会完成第一次借势反噬", "苏晴的怀疑开始萌芽"],
  constraints: ["不虐主", "不送女", "反派不降智", "重大揭示需至少两层铺垫"],
  openQuestions: ["龙王殿势力与离岸资金网的细节是否需要展开设定？", "苏晴知晓叶凡身份的节奏如何安排？"],
  rawSummary:
    "都市隐龙流；龙王殿殿主叶凡入赘查灭门案；信息差爽点；不虐主不送女反派不降智；第一卷借势反噬，第二卷势力重聚，第三卷真相揭示。",
};

/** 演示/测试用：模型应返回的草案 JSON（模拟 LLM 结构化输出）。 */
export const EXAMPLE_DRAFT_JSON: string = JSON.stringify(EXAMPLE_DRAFT, null, 2);
