import type { CharacterAgentGenerateOptions } from '@fly-novel/agents'
import type { BookRuntime } from '../../../novel/runtime'
import type { ChapterState, Dispatch, Simulation } from '../../../novel/types'
import type { ChapterGraphState } from '../state'
import { artifactOf, type StepNode } from '../../types.ts'
import { isRecord, parseSimulations } from '../parse.ts'

/** CharacterAgentManager 的章节级调用端口。 */
export interface CharacterSimulationAgent {
  generate(characterId: string, content: string, options?: CharacterAgentGenerateOptions): Promise<unknown>
}

const CHARACTER_SIMULATION_REQUEST = `请只模拟当前角色，不替其他角色决定台词、动作或反应。仅依据当前角色档案、当前状态和本章提供给该角色的指令行动；不要越过知识边界，不得违反硬限制，也不要把导演的全局意图当作角色已知事实。

输出严格 JSON 数组，且必须恰有一个元素。元素结构如下：
[{"character":"当前角色原名","tier":"S|A","lines":["台词素材"],"actions":["动作素材"],"suspects":["当前怀疑；没有则空数组"],"reasoning":"仅 S 级填写，可省略","risk":"仅 S 级填写，可省略"}]
lines、actions、suspects 必须是字符串数组；不得输出 Markdown 围栏或额外解释。`;

/** 从 CharacterAgent 的 LangGraph 状态中取最后一条助手文本。 */
function characterAgentOutput(result: unknown): { readonly text: string; readonly json?: unknown } | undefined {
  if (!isRecord(result)) return undefined
  if (result.structuredResponse !== undefined) {
    return { text: JSON.stringify(result.structuredResponse), json: result.structuredResponse }
  }
  if (!Array.isArray(result.messages)) return undefined

  for (const message of [...result.messages].reverse()) {
    if (!isRecord(message)) continue
    const messageType = message.type
    if (typeof messageType === 'string' && messageType !== 'ai' && messageType !== 'assistant') continue
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('')
        : ''
    if (text.trim() === '') continue
    const trimmed = text.trim()
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    const jsonText = fenced?.[1] ?? trimmed
    try {
      return { text, json: JSON.parse(jsonText) as unknown }
    } catch {
      return { text }
    }
  }
  return undefined
}

function characterProfile(
  card: BookRuntime['characters'][number],
): string {
  return JSON.stringify({ character: card }, null, 2)
}

function requestForCharacter(dispatch: Dispatch, cast: Dispatch['castPlan'][number], state: unknown): string {
  return `${CHARACTER_SIMULATION_REQUEST}\n\n本章材料：\n${JSON.stringify({
    chapter: dispatch.chapter,
    chapterGoal: dispatch.goal,
    styleNotes: dispatch.styleNotes,
    directive: cast.directive,
    agentQuery: cast.agentQuery,
    hardLimits: cast.hardLimits,
    currentState: state,
  }, null, 2)}`
}

function isSimulationForCast(value: readonly Simulation[] | undefined, cast: Dispatch['castPlan'][number]): value is readonly [Simulation] {
  if (value === undefined || value.length !== 1) return false
  const simulation = value[0]
  return simulation !== undefined
    && simulation.character === cast.name
    && simulation.tier === cast.tier
    && Array.isArray(simulation.lines) && simulation.lines.every((line) => typeof line === 'string')
    && Array.isArray(simulation.actions) && simulation.actions.every((action) => typeof action === 'string')
    && Array.isArray(simulation.suspects) && simulation.suspects.every((suspect) => typeof suspect === 'string')
}

/** 每个 S/A 角色由自己的角色 Agent 生成素材；B 级无需模拟。 */
export function createSimulateNode(
  characterAgents: CharacterSimulationAgent,
  runtime: BookRuntime,
): StepNode<'simulate'> {
  return {
    step: 'simulate',
    run: async (ctx) => {
      const dispatch = artifactOf(ctx, 'direct')
      if (dispatch === undefined) return { outcome: { kind: 'fail', reason: 'simulate 缺少 direct 产物' } }

      const simulations: Simulation[] = []
      for (const cast of dispatch.castPlan) {
        if (cast.tier === 'B') continue
        const card = runtime.characters.find((character) => character.name === cast.name)
        if (card === undefined) {
          return { outcome: { kind: 'fail', reason: `simulate 找不到角色档案：${cast.name}` } }
        }
        if (card.tier !== cast.tier) {
          return { outcome: { kind: 'fail', reason: `simulate 角色级别不一致：${cast.name}（档案 ${card.tier}，Dispatch ${cast.tier}）` } }
        }

        const state = runtime.characterStates[cast.name]
        const content = requestForCharacter(dispatch, cast, state)
        const threadId = cast.tier === 'A'
          ? `${ctx.novelId}_main_${card.characterId}_chapter_${ctx.chapter}`
          : undefined
        let output: unknown
        try {
          output = await characterAgents.generate(card.characterId, content, {
            characterInfos: characterProfile(card),
            ...(threadId === undefined ? {} : { threadId }),
          })
        } catch (error) {
          return {
            outcome: {
              kind: 'fail',
              reason: `simulate 角色 Agent 调用失败（${cast.name}）：${error instanceof Error ? error.message : String(error)}`,
            },
          }
        }

        const agentOutput = characterAgentOutput(output)
        const parsed = agentOutput === undefined ? undefined : parseSimulations(agentOutput)
        if (!isSimulationForCast(parsed, cast)) {
          const preview = JSON.stringify(agentOutput?.text ?? output).slice(0, 200)
          return {
            outcome: {
              kind: 'retry',
              step: 'simulate',
              reason: `角色 Agent 未返回 ${cast.name} 的合法 Simulation（输出预览：${preview}）`,
            },
          }
        }
        simulations.push(parsed[0])
      }

      return { outcome: { kind: 'continue' }, output: simulations }
    },
  }
}

/** LangGraph simulate 节点入口：逐角色调用 CharacterAgentManager 并写回 Simulation[]。 */
export function createSimulateGraphNode(characterAgents: CharacterSimulationAgent, runtime: BookRuntime) {
  const node = createSimulateNode(characterAgents, runtime)
  return async (state: ChapterGraphState) => {
    const result = await node.run({ novelId: state.novelId, chapter: state.chapter, state: state as ChapterState, artifacts: state.artifacts })
    return {
      artifacts: result.outcome.kind === 'continue' && result.output !== undefined
        ? { ...state.artifacts, simulate: result.output }
        : state.artifacts,
      outcome: result.outcome,
    }
  }
}
