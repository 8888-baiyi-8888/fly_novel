import type { AgentPort } from '../agent-port.ts'
import { artifactOf, type StepNode } from '../types.ts'
import { runAgentTask } from './parse.ts'

/**
 * §7.3 写作禁令（来源：小说级开发工作流文档 §7.3；运行时指令的唯一事实来源，README 仅登记出处）。
 * 独立数组便于逐条维护/增删/后续整目录抽离（prompts/）。
 */
export const WRITE_BANS: readonly string[] = [
  '禁黑名单句式：「不是…而是…」「最…最…」「是…更是…」',
  '禁身体反应套话：瞳孔缩成针尖、指节泛白、眼眶微红、喉结滚了滚、空气仿佛凝固、时间仿佛静止',
  '禁水镜系比喻：声音像镜子/湖面/冰碴子、眼神像碎镜/结冰湖面',
  '禁车轱辘话：「你来了/我来了/你不怕死/没有人不怕死」等无信息量往返对话',
  '禁过度解释：「他的眼睛红了，不是哭过的那种红，而是熬夜的红」这类给读者划重点的句子',
  '禁凭空新增：正文不得出现前文不存在的人物、物品、往事、设定；新设定必须先登记（TruthOracle 或 HookLedger）再入文',
  '禁混提示词：正文不得混入提示词、设定说明、括号指令',
  '禁书面语连接词滥用：然而/因此/此外/值得注意的是/不难发现/可想而知/让我们看看，每章合计 ≤3 次',
  '禁模糊情绪标签：「心中五味杂陈」「说不出的味道」这类情绪必须落到具体动作或感官',
  '禁止三段连续句子长度相同；禁止每段都以「他/她」开头',
]

/** 文风正面要求：与禁令互补（禁令是红线，这里是方向），针对「过度描写/死板僵硬」。 */
export const WRITE_STYLE_GUIDE: readonly string[] = [
  '克制：每个动作、环境、心理只点一两个关键细节，不要拆成慢镜头逐帧复述；读者能自己补的一律不写',
  '节奏：长短句交错推进——关键动作用短句（一到十个字），铺陈用长句；禁止三句以上匀速同长',
  '白描：少堆形容词与副词，情绪靠具体动作、对话、物件细节带出来，不靠作者概括',
  '场景切换干净：直接进入下一场，不写「话说回来/与此同时/镜头一转」这类过渡',
  '对话带锋芒：每句对话要有信息量或潜台词，不写寒暄、复述已知事实的来回',
]

/** 指令：基于排程方案与拍摄单撰写正文（纯文本）；遵守场景顺序、角色限制与字数预算，并逐条遵守 §7.3 禁令。 */
export const WRITE_INSTRUCTION = `你是小说正文写手。基于排程方案与拍摄单撰写本章正文（纯文本，不要 JSON，不要 Markdown 代码块）。遵守场景顺序、角色限制与字数预算。

文风要求（往这个方向写，避免说明书式的死板叙述）：
${WRITE_STYLE_GUIDE.map((s, i) => `${i + 1}. ${s}`).join('\n')}

硬性禁令（违反任一即不合格，逐条检查后再输出）：
${WRITE_BANS.map((b, i) => `${i + 1}. ${b}`).join('\n')}`

/** write 节点（参考实现）：产出本章正文文本。 */
export function createWriteNode(agent: AgentPort): StepNode<'write'> {
  return {
    step: 'write',
    run: async (ctx) => {
      const merge = artifactOf(ctx, 'merge')
      if (merge === undefined) return { outcome: { kind: 'fail', reason: 'write 缺少 merge 产物' } }
      const call = await runAgentTask(agent, {
        task: 'write',
        instruction: WRITE_INSTRUCTION,
        context: JSON.stringify(merge),
      })
      // agent 调用失败（超时/网络抖动）→ retry 回 write，预算内自动重跑；预算耗尽由引擎挂起保留现场。
      if (!call.ok) return { outcome: { kind: 'retry', step: 'write', reason: `write agent 调用失败：${call.reason}` } }
      const draft = call.output.text.trim()
      if (draft === '') return { outcome: { kind: 'retry', step: 'write', reason: 'write 产物为空' } }
      return { outcome: { kind: 'continue' }, output: draft }
    },
  }
}
