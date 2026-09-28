import type { BookRuntime } from '../../novel/runtime'
import { HOOK_TYPES } from '../../novel/types'
import type { AgentPort } from '../agent-port.ts'
import { artifactOf, type StepNode } from '../types.ts'
import { parseRuntimeDelta, runAgentTask } from './parse.ts'

/** settle 节点依赖：书运行时（回写目标）。 */
export interface SettleNodeDeps {
  readonly runtime: BookRuntime
}

/** 指令：要求输出严格符合 RuntimeDelta 结构的三类 delta（带结构示例 few-shot；判据见文档 §11.1）。
 * 判据要点：resolve=读者读完能说出"原来那时候是那个意思"；advance=删掉这段伏笔离回收近一步（仅再次看见/想起=mention）；
 * open=有明确预期回收的新暗示（写不出预期回收就报，那是杂讯）；角色"以为"但叙述层不符的是 suspects 进状态，不是 fact。 */
export const SETTLE_INSTRUCTION = `你是结算器。从正文提取状态 delta，输出 RuntimeDelta（严格 JSON，禁止 Markdown 代码块，禁止额外包装键）。

判据：
1. resolve：本章是否让某条未回收伏笔得到明确解答？只是"又提了一下"不算。
2. advance：本章是否为某条伏笔提供新的、之前不存在的信息？删掉这段，伏笔离回收近一步吗？不近 → 不是 advance。仅再次看见同一物件/想起同一句话 → mention（不更新 lastAdvancedChapter）。
3. open：本章是否新埋了暗示？写不出预期回收不要报——那不是伏笔，是杂讯。
4. fact：提取时态三元组并标注 knownBy（本章结束时谁知道）；角色"以为"但与叙述层不符的 → 写进 stateChanges.suspects，不是 fact。
5. defer：正文明确把某条伏笔挂起时；若账本中该条为 coreHook，不得 defer。
6. hookId 必须引用账本中已存在的伏笔（见 context 的 ledger 快照，含 status/lastAdvancedChapter/notes），账本中不存在的一律不操作；open 是新建伏笔，不写 hookId（由系统分配）。

严格按以下结构输出（字段名与类型必须一致，数组不能缺）：
{
  "facts": [ { "subject": "主体", "subjectType": "character|location|item|relationship|event|world", "predicate": "谓词", "object": "客体", "knownBy": ["本章结束时知道的人"] } ],
  "hookOps": [
    { "op": "open", "type": "${HOOK_TYPES.join('|')}", "description": "描述", "payoffTiming": "immediate|near-term|mid-arc|slow-burn|endgame", "expectedPayoff": "预期回收", "echoHint": "埋设原文摘录" },
    { "op": "advance", "hookId": "H00x", "how": "怎么推进", "to": "progressing", "lastAdvancedChapter": 0, "advancedCount": 2 },
    { "op": "resolve", "hookId": "H00x", "how": "怎么回收", "echoFrom": "账本 notes 摘录" },
    { "op": "defer", "hookId": "H00x", "reason": "原因", "untilChapter": 99 },
    { "op": "mention", "hookId": "H00x" }
  ],
  "stateChanges": { "角色名": { "location": "新位置", "goal": "新目标", "emotion": "新情绪", "suspects": ["新增怀疑"], "inventory": ["新增物品"], "bonds": { "对方": 10 } } }
}
示例（无任何变更时，字段不可省略）：
{"facts":[],"hookOps":[],"stateChanges":{}}`

/**
 * settle 节点（参考实现）：产出 RuntimeDelta 并回写 BookRuntime（§11.3 纯函数部分）——
 * 六步校验（§11.2）拒绝 → retry 回 settle（校验摘要进 reason）；applied 则账本/真相/时钟/角色状态
 * 同批更新。原子落盘（持久化 WorkflowStore）仍属存储层，不在本节点。
 */
export function createSettleNode(agent: AgentPort, deps: SettleNodeDeps): StepNode<'settle'> {
  return {
    step: 'settle',
    run: async (ctx) => {
      const draft = artifactOf(ctx, 'write')
      if (draft === undefined) return { outcome: { kind: 'fail', reason: 'settle 缺少 write 产物' } }
      const call = await runAgentTask(agent, {
        task: 'settle',
        instruction: SETTLE_INSTRUCTION,
        context: JSON.stringify({
          draft,
          hookContext: deps.runtime.ledger.viewForChapter(ctx.chapter),
          ledger: deps.runtime.ledgerView,
        }),
        outputFormat: 'json',
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `settle agent 调用失败：${call.reason}` } }
      const delta = parseRuntimeDelta(call.output)
      if (delta === undefined) {
        return { outcome: { kind: 'retry', step: 'settle', reason: 'settle 产物不是合法 RuntimeDelta JSON' } }
      }
      const result = deps.runtime.settleChapter(ctx.chapter, delta)
      if (result.kind === 'rejected-batch') {
        return {
          outcome: {
            kind: 'retry',
            step: 'settle',
            reason: `settle 产物未通过六步校验（${result.rule}）：${result.violations.map((v) => v.message).join('；')}`,
          },
        }
      }
      return { outcome: { kind: 'continue' }, output: delta }
    },
  }
}
