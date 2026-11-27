import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadConfiguredAdapter } from './call-llm.js'
import { continueStoryTree, createNextStoryPlan, createStoryPlan, readStoryRoundResult, runStoryTree, type StoryTreeOptions } from './story-workflow.js'

/** 用固定的曲水城资料走真实导演调用，角色行动由本入口的模拟器提供。 */
async function main(): Promise<void> {
  const provider = process.argv[2] ?? 'deepseek'
  const minutes = Number(process.argv[3] ?? 10)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    console.error('调试时限须为 1 到 60 分钟的整数。')
    process.exitCode = 1
    return
  }
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop)
  const timeout = AbortSignal.timeout(minutes * 60_000)
  const signal = AbortSignal.any([abort.signal, timeout])
  try {
    console.log(`读取本机模型配置（${provider}）`)
    const model = await loadConfiguredAdapter(provider)
    const temp = resolve('tmp')
    await mkdir(temp, { recursive: true })
    const root = await realpath(await mkdtemp(join(temp, 'story-workflow-debug-')))
    const planRoot = join(root, 'plans')
    const collaborationRoot = join(root, 'collaborations')
    await Promise.all([mkdir(planRoot), mkdir(collaborationRoot)])
    console.log(`运行记录：${root}`)
    const planning = { ...model, root: planRoot, collaborationRoot, protectedRoots: [] }
    const plan = await createStoryPlan({ ...planning, protectedRoots: [collaborationRoot] }, {
      task: '调试曲水城一轮演化。安排两个范围明确的初步事件，围绕商队夜间抵达和货物安置。',
      facts: ['守卫夜间关闭城门', '商队抵达城外时天已黑'],
      directions: ['为商队寻找临时等候点', '为次日恢复商贸留下可能'],
    }, signal)
    console.log('初步规划', JSON.stringify(plan, null, 2))
    if (plan.outcome.kind === 'no_events') throw new Error('真实导演未生成可推进事件')

    let firstLeaf = true
    const simulate: StoryTreeOptions['simulate'] = async ({ task, preparation, reportEarly }, simSignal) => {
      simSignal.throwIfAborted()
      console.log('模拟演绎', { goal: task.goal, preparation })
      const unresolved = ['入城手续仍待处理']
      if (firstLeaf) {
        firstLeaf = false
        const situation = '合成场景观察：城门外原来的货车等候点开始积水。'
        const decision = await reportEarly({ id: randomUUID(), situation })
        console.log('提前汇报的上级决定', decision)
        if (decision.action === 'terminate') return { kind: 'simulation', summary: situation, changes: [], unresolved, evidence: '调试模拟器在收到终止决定后结束演绎' }
        if (decision.action === 'adjust') return {
          kind: 'simulation', summary: '商队暂停使用原等候点，并记录上级的调整方向。',
          changes: ['原等候点停止使用'], unresolved: [...unresolved, decision.direction], evidence: situation,
        }
      }
      return { kind: 'simulation', summary: '商队暂留城外等待，城门保持关闭。', changes: ['商队在城外等待'], unresolved, evidence: '曲水城调试模拟器' }
    }
    const options = { ...model, planRoot, collaborationRoot, protectedRoots: [], limit: 1, simulate }
    let result = await runStoryTree(options, plan.id, signal)
    while (result.kind === 'paused') {
      console.log(`第 ${result.batch} 批已暂停，完成 ${result.completedCount} 个最小子故事。继续下一批。`)
      result = await continueStoryTree(options, plan.id, result.batch, signal)
    }
    const round = await readStoryRoundResult(options, plan.id)
    console.log('整轮评估', round.assessment)
    const next = await createNextStoryPlan(planning, plan.id, {
      task: '规划曲水城天亮后的下一轮演化',
      facts: ['调试样例提供的新局势：天已亮，城门重新开放'],
      directions: ['处理商队的入城和货物登记'],
    }, signal)
    console.log('下一轮规划', JSON.stringify(next, null, 2))
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  } finally {
    process.removeListener('SIGINT', stop)
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const label = error instanceof Error ? error.name : 'UnknownError'
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{2,40}$/.test(error.code) ? `/${error.code}` : ''
    console.error(`真实模型调试未完成（${label}${code}）。请检查本机模型配置、运行记录或在调试器中查看异常。`)
    process.exitCode = 1
  })
}
