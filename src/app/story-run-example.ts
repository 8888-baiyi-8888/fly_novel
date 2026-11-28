import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CharacterStore } from '@fly-novel/character'
import { FsVersion } from '@fly-novel/fs'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { storyRunIdSchema } from '../story-workflow/run-records.js'
import { openStoryConvoyState } from './story-convoy-state.js'
import { openStoryRunWorkflow, type StoryRunWorkflowOptions } from './story-run-workflow.js'

const worldId = '曲水城'
const deliveryId = '0a879643-8d28-4581-b570-c72d4b5ad543'
const convoyId = '6edeb411-c266-484c-bb84-a913f40ad62f'
const runId = '203133ef-6b60-4b67-a87a-788862a3db3c'
const nextId = 'b4ceeaa4-e281-4643-a1bb-b49c9420960a'
const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/city.md' }
const closed = '曲水城北门夜间关闭'
const waiting = '商队已经在北门外等候点停稳'
const report = { summary: '关闭的城门外，商队停在获准等候点。', changes: [], unresolved: ['等待天亮核对入城条件'], evidence: '固定场景的行动判断与商队回执' }

class FixedAdapter extends LlmAdapter {
  constructor(private readonly respond: (prompt: string) => unknown) { super() }
  override async *stream(input: GenerateOptions): AsyncIterable<StreamChunk> {
    const value = this.respond(JSON.stringify(input.messages.at(-1)))
    yield { type: 'block-end', index: 0, block: { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function director(characterId: string) {
  return new FixedAdapter(prompt => {
    if (prompt.includes('规划本轮事件初步安排')) return { kind: 'planned', events: ['处理北门外的商队'] }
    if (prompt.includes('判断当前子故事继续')) return { decision: 'continue', reason: '准备处理商队落脚' }
    if (prompt.includes('制定当前子故事任务')) return { background: '守卫在关闭的北门外遇到商队', goal: '安排安全等候', constraints: ['执行夜间闭门规则'] }
    if (prompt.includes('判断当前故事能否直接')) return { kind: 'direct', preparation: '核对北门外等候点' }
    if (prompt.includes('从候选中选择参与者')) return { participants: [{ characterId, invitation: '在门外引导商队' }] }
    if (prompt.includes('判断行动尝试的实际结果')) return [{ index: 0, status: 'succeeded', reason: '车队均已停稳', observable: waiting }]
    if (prompt.includes('逐角色判断能感知哪些发言')) return { perceptions: [{ characterId, status: 'not-received', reason: '本人发言', observations: [] }], next: { kind: 'end', reason: '等候安排完成' } }
    if (prompt.includes('形成最终回报')) return report
    if (prompt.includes('接收下级故事回报')) return '已接收城门回报'
    if (prompt.includes('评估当前目标')) return { status: 'achieved', reason: '等候状态已核对', report }
    throw new Error('固定导演遇到未登记的调用')
  })
}

async function main() {
  const [directory, command = directory ? 'inspect' : 'start'] = process.argv.slice(2)
  if (!['start', 'inspect', 'approve', 'advance', 'next'].includes(command)) throw new Error('可选操作为 start、inspect、approve、advance、next')
  if (!directory) await mkdir(resolve('tmp'), { recursive: true })
  const root = await realpath(directory ? resolve(directory) : await mkdtemp(join(resolve('tmp'), 'story-run-example-')))
  const planRoot = join(root, 'plans')
  const collaborationRoot = join(root, 'stories')
  const runRoot = join(root, 'runs')
  const worldRoot = join(root, 'world')
  const stateRoot = join(root, 'state')
  const characterRoot = join(worldRoot, 'characters')
  if (!directory) await Promise.all([planRoot, collaborationRoot, runRoot, stateRoot, characterRoot].map(path => mkdir(path, { recursive: true })))
  const characters = await CharacterStore.open(characterRoot, !directory)
  const lifecycle = new AbortController()
  const stop = () => lifecycle.abort(new Error('用户中断'))
  process.once('SIGINT', stop)
  try {
    const identityPath = join(root, 'example-character.json')
    const characterId = directory ? storyRunIdSchema.parse(JSON.parse(await readFile(identityPath, 'utf8'))) :
      (await characters.create({ name: '守卫', summary: '北门值守', body: '守卫负责北门与门外等候点。', categories: {} })).id
    if (!directory) await writeFile(identityPath, JSON.stringify(characterId), { flag: 'wx' })
    const profile = (await characters.readVersioned(characterId)).version
    const owner = { agentId: 'characters', writableRoot: characters.rootDirectory }
    const binding: StoryRunWorkflowOptions['binding'] = {
      deliveryId, world: { worldId, readRoot: worldRoot, confirmedRoot: worldRoot, catalogRoot: worldRoot, mainAgent: owner, agents: [owner] },
      async readDelivery(targets) {
        if (targets.length !== 1 || JSON.stringify(targets[0]) !== JSON.stringify(target)) throw new Error('目标超出固定交付')
        return { worldId, deliveryId, formatVersion: 1, version: FsVersion('fixture-1'), reviewVersion: 'fixture-1',
          notes: [], uncovered: [], deferred: [], acknowledgedUncovered: [],
          artifacts: [{ target, version: '1', content: closed, digest: createHash('sha256').update(closed).digest('hex') }] }
      },
    }
    const model = { provider: 'fixture', model: 'fixture' }
    const roots = { planRoot, collaborationRoot, protectedRoots: [stateRoot] }
    const convoy = { worldRoot, stateRoot, convoyId,
      async authorize({ action }: Parameters<NonNullable<Parameters<typeof openStoryConvoyState>[1]['authorize']>>[0]) {
        return action.observable === waiting ? '核对北门外等候点' : undefined
      },
      async selectChange() { return { sequence: 1, actionIndex: 0, locationId: '北门外等候点' } },
    }
    const service = await openStoryRunWorkflow({ ...roots, runRoot, binding, configurationVersion: 'example-1',
      director: { ...model, adapter: director(characterId) },
      execution: { review: { policy: { kind: 'indefinite' } },
        worldObjectives: [{ id: 'waiting', description: '使车队安全等候', criterion: { kind: 'convoy-waiting' } }],
        scene: { maxEvents: 5, convoy,
          characters: { store: characters, ownerAgentId: owner.agentId,
            configure: () => ({ ...model, version: '1', timeoutMs: 5000, adapter: new FixedAdapter(() => ({
              kind: 'respond', speech: [{ text: '请在门外安全等候。', channel: 'normal', intendedCharacterIds: [] }], actions: ['引导车队在北门外停稳'],
            })) }) },
          async prepare() {
            return { candidates: [{ characterId, version: profile, presence: '北门值守' }], initialCandidates: [characterId],
              async grants(_, scene) {
                return [{ sceneId: scene.sceneId, characterId, category: 'profile', content: '守卫负责北门与门外等候点。', basis: '已授权档案', source: { kind: 'profile' } },
                  { sceneId: scene.sceneId, characterId, category: 'observation', content: scene.situation, basis: '在场', source: { kind: 'scene', field: 'situation' } }]
              },
              async conditions() { return { version: '1', participants: [{ characterId, position: '北门', hearing: 'clear', sight: 'clear', basis: '在场' }] } },
              allowObservation: () => true,
            }
          },
        },
      },
    })
    try {
      const selection = { task: '安排抵达曲水城的商队', delivery: [{ target, category: 'setting' as const }],
        fixed: [{ id: 'arrival', version: '1', category: 'event' as const, content: '商队已经抵达北门外' }] }
      if (command === 'start') {
        const plan = await service.start(runId, selection, lifecycle.signal)
        const state = await openStoryConvoyState({ ...roots, protectedRoots: [] }, { ...convoy, worldId, runId: plan.id })
        await state.initialize({ sourceId: 'arrival', version: '1' })
        const ready = await service.diagnose(runId)
        if (ready.status === 'ready') await service.advance(runId, ready.version, lifecycle.signal)
      }
      if (command === 'approve') {
        const current = await service.diagnose(runId)
        if (current.status !== 'awaiting-review' || current.batch === undefined) throw new Error('当前没有等待选择的审阅')
        await service.submitReview(runId, current.batch, current.review, { kind: 'select', optionId: current.review.recommendedId }, lifecycle.signal)
      }
      if (command === 'advance') await service.advance(runId, (await service.diagnose(runId)).version, lifecycle.signal)
      if (command === 'next') await service.startNext(runId, nextId, { ...selection, task: '天亮后再次核对入城条件' }, lifecycle.signal)
      const outcome = await service.diagnose(command === 'next' ? nextId : runId)
      process.stdout.write(JSON.stringify({ root, ...outcome }) + '\n')
    } finally { await service.close() }
  } finally { process.removeListener('SIGINT', stop); await characters.close() }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '固定样例运行失败')
    process.exitCode = 1
  })
}
