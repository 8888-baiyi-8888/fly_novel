/** 创意草案的结构化输出描述（供提示词与模型调用契约使用）。 */
export const DRAFT_JSON_DESCRIPTION = `输出 JSON 对象，字段如下：
- 角色定位：你是「创意草案整理器」，把用户原始输入抽取成结构化草案，不是设定生成器。
- 抽取规则（必须遵守）：
  1. 只抽取用户表达过的内容，不擅自新增设定、不编造用户没说的细节；
  2. 用户没提、拿不准、有矛盾的地方不要硬填，一律写入 openQuestions；
  3. 这是"草案"不是"完整设定"：配角只列用户提到的关键人物与一句话定位，分卷只写用户表达的方向；
     详细的角色卡（tier/秘密/知识边界）、分卷规划、叙事线事件链、节拍板由后续节点（N3-N5）生成，不在这里展开；
  4. 用户输入很短时，草案也相应精简；不要为了填满字段而脑补。
- schemaVersion: 数字，固定 2
- title: 书名（字符串；未定可不填，不要输出空字符串）
- genre: 题材数组，至少一个元素，如 ["都市","隐龙流"]
- protagonists: 主角们数组（可选），支持单主角/双主角/群像，每项 { name: 姓名, age: 年龄(可选), identity: 身份/职业(可选), traits: 长期性格数组(可选), coreNeed: 核心需求(可选), coreFear: 核心恐惧(可选) }；单主角也写成数组，如 [{ "name": "叶凡" }]；两个主角就写两项
- supportingCast: 配角数组（可选）：[{ name: 姓名, identity: 身份/定位(可选), traits: 长期性格数组(可选), relation: 与主角关系(可选) }]
- worldPremise: 世界前提（字符串，可选）——一句话说明这个世界是什么样
- setting: 世界观要点/补充设定数组（可选）
- coreConflict: 核心冲突/主题（字符串，可选）
- blurb: 简介/一句话故事卖点（字符串，可选）
- authorIntent: 作者意图——作者为什么这样写（字符串，可选）
- tone: 期望风格数组，至少一个元素，如 ["现实","慢热"]
- volumePlan: 卷规划数组（可选，用户已表达的部分）
- currentFocus: 当前重点数组（可选）——最近一段时间主要解决什么
- constraints: 创作约束数组（可选）
- platform: 目标平台（字符串，可选），如 "番茄"
- targetChapters: 目标章节数（数字，可选）
- chapterWordCount: 单章字数（数字，可选）
- language: 语言（字符串，可选），如 "zh"
- openQuestions: 待澄清问题数组（拿不准/缺失/矛盾的地方写在这里）
- rawSummary: 原始输入要点摘要（字符串）
不得输出 JSON 以外的内容。`;

/**
 * 澄清轮（多轮问答）的结构化输出描述。
 * 协议：有需要澄清的问题时只给 questions、draft 为 null；
 * 问题清空后给出完整草案；最后一轮必须给出草案、未决问题写入草案 openQuestions。
 */
export const CLARIFY_JSON_DESCRIPTION = `输出 JSON 对象，用于澄清与生成两个阶段，字段如下：
- questions: 需要用户进一步回答的问题数组（每项是非空字符串；没有问题时必须为空数组 []）
- draft: 创意草案对象或 null（草案字段见下方说明）

协议规则（必须遵守）：
- 还有需要澄清的问题时：questions 填写问题列表，draft 必须为 null；
- 所有问题都已澄清、可以直接给出草案时：questions 必须为 []，draft 填写完整创意草案；
- 最后一轮（用户表示不再回答）时：无论问题是否全部澄清，都必须给出完整草案；无法澄清的问题写入草案的 openQuestions 字段，questions 为 []。

草案字段（draft 非 null 时按此结构）：
${DRAFT_JSON_DESCRIPTION}`;
