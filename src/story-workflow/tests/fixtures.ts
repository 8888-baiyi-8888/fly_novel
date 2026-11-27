import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { createStoryPlan } from '../../app/story-workflow.js'

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly responses: string[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const content = this.responses.shift()
    if (content === undefined) throw new Error('缺少测试响应')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: content } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function createTestDirectory(t: TestContext, prefix: string) {
  const base = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

export const task = '{"background":"商队抵达","goal":"处理入城请求","constraints":["夜间城门关闭"]}'
const outcome = { summary: '守卫拒绝开门', changes: ['商队扎营'], unresolved: ['货物'], evidence: '模拟交涉经过' }
export const report = JSON.stringify(outcome)
export const simulation = { kind: 'simulation' as const, ...outcome }

export async function setup(t: TestContext, events = ['商队夜间抵达', '处理货物']) {
  const base = await createTestDirectory(t, 'story-collaboration-')
  const planRoot = join(base, 'plans')
  const collaborationRoot = join(base, 'collaborations')
  await Promise.all([mkdir(planRoot), mkdir(collaborationRoot)])
  const baseOptions = { planRoot, collaborationRoot, protectedRoots: [] as string[], provider: 'test', model: 'test' }
  const plan = await createStoryPlan({ root: planRoot, protectedRoots: [collaborationRoot], provider: 'test', model: 'test', adapter: new ScriptedAdapter([JSON.stringify({ kind: 'planned', events })]) }, { task: '处理城防与商贸矛盾', facts: ['夜间城门关闭'], directions: ['城防与商贸可能趋紧'] })
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  return { baseOptions, plan, eventId: plan.outcome.events[0]!.id }
}

export const advance = '{"decision":"continue","reason":"继续"}'
export const leaf = (name: string) => [advance, task, JSON.stringify({ kind: 'direct', preparation: name }), report, '已接收']
export const achieved = JSON.stringify({ status: 'achieved', reason: '目标达成', report: outcome })
