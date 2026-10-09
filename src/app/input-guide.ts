/**
 * N0 输入建议：给「写小说的人」看的创作输入模板（生产环境使用说明）。
 *
 * N0 输入是自由自然语言，不强制作任何格式；但信息越全，N1 草案越准。
 * 按下面结构组织即可（缺的可以不写，模型会写进 openQuestions「待澄清问题」）。
 * 本常量通过 `node dist/app/novel-workflow/workflow.js --help` 打印。
 */

export const INPUT_GUIDE = `
【N0 原始输入 · 生产建议】
第一步只给"小说要写什么、怎么写"，一段话（或几句话）就够。建议覆盖：
  1. 题材与定位（如：都市隐龙流爽文 / 职场百合励志文）
  2. 主角（谁、表面是什么、真实是什么、想干什么）
  3. 核心卖点/爽点（读者爽在哪，如信息差、"轻描淡写的正确"）
  4. 冲突/主线（主角要解决什么问题）
  5. 创作约束（不能写什么：不虐主、不送女、不降智……）
  6. 目标平台与篇幅（如：番茄、100 章、每章 2500 字）

推荐操作：把想法存成 txt 文件（UTF-8 编码），再运行：
  node dist/app/novel-workflow/workflow.js --model real --file 你的想法.txt --clarify

说明：
- N0 会把你几句话的想法自主扩展成一段完整原始输入（主角/配角/主线/约束/平台篇幅由模型补全），
  小说级 LangGraph 入口将产物存到 .fly-novel-store/<novelId>/normalized_input/；旧版 main.ts 入口仍使用全局 n0-raw-input/。
  如果你对模型补全的内容不满意，可以修改该 md 文件；小说级 LangGraph 入口用相同 novelId 重跑草案节点。
- 详细设定（配角档案、分卷细纲、事件链、爽点具体场景）不需要写在第一步；
  后续节点（N3 架构师、N5 静态架构）会自动生成；你已有的详细设定可另存为
  "创作素材"文件，在 N5 阶段作为参考喂给架构师，不要塞进 N0 输入。
- 拿不准/缺失/矛盾的地方，模型会写进草案的 openQuestions；配合 --clarify
  在遇到矛盾时会直接向你追问（最多 3 轮）。

《隐龙》示例输入（也是项目内置演示输入）：
我想写一本都市隐龙流小说。主角叶凡，表面上是上门女婿，在江氏贸易当小职员，
其实是龙王殿殿主，掌控着一张离岸资金网。他入赘是为了查五年前叶家的灭门案，
他是唯一的幸存者。我想写的是信息差——所有人都以为他是废物，包括他妻子苏晴。
爽点来源不是他多强，而是他每次"轻描淡写的正确"。前期借岳母逼签离婚协议的势
反噬江家，中期重新聚拢旧部势力，最后揭开灭门真相。不要虐主、不要送女、
不要把反派写成无脑降智。目标平台番茄，100 章左右完结。
`;

/** 命令行用法说明。 */
export const USAGE = `
用法：node dist/app/novel-workflow/workflow.js [选项]
  --model memory|real   模型类型（默认 memory；novel-workflow/workflow.ts 无参数运行时使用 real 示例）
  --input "文本"         直接传原始输入（短文本适用）
  --file <路径>          从 txt 文件读取原始输入（推荐）
  --novel-id <ID>        小说级 LangGraph 单步续跑使用的 ID（ni 可自动生成；旧版 main.ts 不支持）
  --step ni|dra|sf|con|arc|sta|wor|rea  只跑单个节点（默认执行完整建书流程）
                           ni：扩展原始输入（有缓存跳过）；dra：读最新整理输入，生成草案及 BookConfig；
                           sf：读最新草案+BookConfig，架构师生成故事圣经与书籍规则；
                           con：读最新 N1 草案，作者意图整理器生成长期创作控制四件套；
                           arc：读最新 N1+N3+N4 产物，架构师生成前四件、Director 生成节拍板；
                           sta：读最新 N5 产物，生成初始化运行状态 State₀ 六类；
                           wor：读前序全部产物，生成书项目目录（纯程序，不调 LLM）
                           rea：验收书目录八类内容物 + AI 红线扫描消毒 + 写交接凭据（纯程序，不调 LLM）
  --force                N7 书目录已存在时强制重建（默认存在则跳过，保护手改的权威文件）
  --book <bookId>        N8 指定要验收的书籍目录
  --clarify              进入多轮反问（仅 real 模式的 N1 生效；N0 默认自主补全，只在遇到矛盾时才问）
  --help                 显示本帮助与 N0 输入建议

real 模式全链路：整理输入 → 草案（同时固化书籍配置）
                 →（故事基础设定 ‖ 长期创作控制 并行）→ 静态架构 → 初始运行状态
                 → N7 书项目目录（持久化工作空间）→ N8 验收+红线消毒+交接凭据
  N0：把几句粗想法扩展成一段完整原始创作输入（主角/配角/主线/约束/平台篇幅由模型自主补全）
  N1：把原始输入整理成结构化创意草案（含书名/题材/平台/字数/章节数/语言等运行参数），
      并在同一节点固化 BookConfig + bookId（书名拼音 ID，如 隐龙→yinlong）
  N3：架构师产出故事圣经（这个世界是什么）+ 书籍规则（允许怎么写，含内置 AI 写作红线 11 条）
  N4：作者意图整理器把草案创作意图扩展为四件套（作者意图/当前重点/分卷方向/创作约束），
      与世界事实、写作规则严格分离；与故事基础设定并行，只依赖草案
  N5：架构师把 N3+N4+草案组织成五件套（故事框架/分卷规划/角色卡/叙事线地图），
      Director 再把前四件细化成全书节拍板（每章一句话蓝图，过验收闸门）
  N6：TruthOracle + Hook Ledger 把静态架构转成"故事开始这一刻"的初始运行状态 State₀
      （人物状态/关系状态/世界状态/伏笔种子账本/线状态板/进度），伏笔种子过准入闸门，
      每章后 Stateₙ → 第 n 章 → Stateₙ₊₁ 滚动前进
  N7：持久化工作空间——把前序产物序列化成书项目目录（纯程序，不调 LLM）：
      inkos.json（书配置+平台节奏尺子）/ story/*.md（人读权威，含 hooks.md 伏笔账本）
      / state/*.json（机器读权威）/ beats.json（节拍板）/ chapters、runtime、export（空目录待填）
  小说级产物根目录：.fly-novel-store/<novelId>/；草案节点分别存入 draft_node 和 book_config，
                其余节点存入 normalized_input、story_foundation、controls_node、architecture_node、state0_node、
                workspace_node/{bookId}/ 和 ready_node/。旧版 main.ts 仍使用全局 n0～n7 目录。

真实模型（--model real）配置：不读取 .env，使用项目正式机制——
  .fly-novel/settings.json 配置供应商（当前 qwen：baseURL / model / credentialRef / responseFormat）
  .fly-novel/.credentials.json 存放加密凭据（先运行 pnpm run init-encryption-key 和 pnpm run credentials encrypt）
  详见 src/config/README.md
`;
