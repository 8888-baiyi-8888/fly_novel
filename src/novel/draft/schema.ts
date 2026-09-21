/** 创意草案的结构化输出描述（供提示词与模型调用契约使用）。 */
export const DRAFT_JSON_DESCRIPTION = `输出 JSON 对象，字段如下：
- schemaVersion: 数字，固定 1
- title: 书名（字符串；未定可不填）
- genre: 题材数组，至少一个元素，如 ["都市","隐龙流"]
- protagonist: 主角对象（可选）：{ name: 姓名, age: 年龄(可选), identity: 身份/职业(可选), traits: 长期性格数组(可选), coreNeed: 核心需求(可选), coreFear: 核心恐惧(可选) }
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
