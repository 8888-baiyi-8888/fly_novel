import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@fly-novel/agents'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { loadConfiguredAdapter } from './call-llm.js'
import { openWorldInitializationWorkflow } from './world-initialization-entry.js'
import { observeWorldInitializationProgress } from './world-initialization-progress.js'
import { initializeCatalog, readCatalog } from '../world-init/workspace/catalog/format.js'
import { candidateSchema, type DiscussionTarget, type DiscussionTargetAdapter } from '../world-init/discussion/service.js'
import { withFileDiscussionAdapter } from '../world-init/discussion/file-adapter.js'

/** 修改这些字符串即可替换样例中的用户输入；确认均为程序模拟。 */
export const sampleInput = {
  worldIdea: '创建一个资源有限的河谷城邦世界。近期只创建一个地点曲水城、一个主要组织青河议会和一名重要人物；地图其他地区仅作概述或留白，不创建额外地点。城邦受河水季节变化影响，外海留白。请按实际需要安排世界基础、地图、组织、人物、历史、初始局势、发展方向和专有内容，区分已确定事实、建议、未来方向与留白。',
  firstVersionInstruction: '以上构想已提供，请按需委派各专用 Agent 完成世界第一版，读取实际成果，整合完整方案并调用 save_first_world_plan 保存待审总览。不要把总览保存成功单独视为资料完整，明确报告未完成内容和未覆盖范围。',
  firstVersionDecision: '模拟用户确认第一版完整',
  discussionRequest: '请讨论并完善第一版总览中曲水城的城门规则：夜间关闭，但紧急医疗运输可以申请通行。先读取当前资料，再调用 discussion_prepare 保存修改后的完整总览，保留其他内容。不要直接修改当前资料。',
  reviewDecision: '模拟用户确认所展示的候选并继续',
  uncoveredDecision: '模拟用户知悉所列未覆盖范围',
  deliveryDecision: '模拟用户确认完成初始化',
} as const

/** 单轮超时由样例配置；超时只停止生成，已保存资料保留。 */
export const sampleTimeouts = { initialMs: 1_800_000, discussionMs: 600_000 }

async function runTurn(agent: Agent, prompt: string, timeoutMs: number, write: (text: string) => void) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('样例超时必须是正整数')
  const stopProgress = observeWorldInitializationProgress(agent, write)
  const timer = setTimeout(() => { write('进度> 已达到本轮超时，正在取消生成；已保存的资料会保留。'); agent.cancel() }, timeoutMs)
  try { return await agent.run({ prompt }) } finally { clearTimeout(timer); stopProgress() }
}

export type WorldInitializationSampleInput = { readonly [K in keyof typeof sampleInput]: string }

const ownerIds = ['basics', 'characters', 'map', 'organization', 'history', 'situation', 'development', 'specific'] as const
const subdirectories = [
  'world/main', 'world/confirmed', 'world/catalog', 'world/basics', 'world/characters', 'world/map/places', 'world/map/connections',
  'world/organization/organizations', 'world/organization/relations', 'world/organization/memberships', 'world/history/events', 'world/history/candidates',
  'world/situation/overviews', 'world/situation/situations', 'world/situation/candidates', 'world/specific/topics', 'world/specific/items', 'world/specific/candidates',
  ...['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines',
    'character-growth/blueprints', 'character-growth/items', 'candidates'].map(name => `world/development/${name}`),
  'sessions', 'discussion/discussions', 'discussion/candidates', 'impact', 'review/reviews', 'review/confirmations',
  'commit', 'batch', 'task/tasks', 'task/first-versions', 'delivery/reviews', 'delivery/deliveries',
]

/** 在新建隔离目录运行完整示例；成功与失败都保留资料供核查。 */
export async function runWorldInitializationFullExample(input: WorldInitializationSampleInput = sampleInput, write: (message: string) => void = console.log) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'world-initialization-example-')))
  write(`样例目录：${root}`)
  write('本样例中的用户输入和确认均由文件顶部的字符串模拟，不代表实际用户审阅。')
  for (const name of subdirectories) await mkdir(join(root, name), { recursive: true })
  const view = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  const world = { worldId: randomUUID(), readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: ownerIds.map(agentId => ({ agentId, writableRoot: join(view, agentId) })) }
  await initializeCatalog(world.catalogRoot, world.worldId)
  const roots = { task: join(root, 'task'), discussion: join(root, 'discussion'), impact: join(root, 'impact'), review: join(root, 'review'),
    commit: join(root, 'commit'), batch: join(root, 'batch'), delivery: join(root, 'delivery') }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  if (!(context.fs instanceof LocalFileSystem)) { await backend.dispose(); throw new Error('样例需要本机文件后端') }
  const base: DiscussionTargetAdapter = { async read() { throw new Error('此样例只装配文件读取') },
    async validate() { throw new Error('此样例未装配该类型的候选') }, async validateStored() { throw new Error('此样例未装配该类型的候选') },
    async assertNoLegacyCandidate() { throw new Error('此样例未装配该类型的候选') } }
  const adapter = withFileDiscussionAdapter(base, world, context.fs)
  let opened: Awaited<ReturnType<typeof openWorldInitializationWorkflow>> | undefined
  try {
    opened = await openWorldInitializationWorkflow({ worlds: [world], worldId: world.worldId, roots, sessionRoots: [sessionRoot],
      fs: context.fs, adapter, publisher: {}, singleWriterProcess: true })
    const workflow = opened.workflow
    const taskId = randomUUID(); const initialSession = 'initial'; const discussionSession = 'overview-discussion'
    await workflow.createTask({ id: taskId, sessionIds: [initialSession, discussionSession], createdAt: new Date().toISOString() })

    // 1. 接收字符串形式的世界构想，装配主 Agent 和全部已有专用 Agent。
    write('\n【第一步】根据世界构想生成第一版')
    const model = await loadConfiguredAdapter('deepseek')
    const child = (agentId: typeof ownerIds[number]) => ({ ...model, agentId, sessionRoot, sessionId: agentId,
      sessionMode: 'create' as const, maxSteps: 30 })
    const initial = await workflow.startAgentForTask({ taskId, session: { sessionRoot, sessionId: initialSession, sessionMode: 'create' },
      characterCreator: { ...child('characters'), initializeCharacters: true, defaultCharacterCount: 1 },
      options: { mainMaxSteps: 80, catalog: {}, worldBasics: child('basics'), mapAgent: child('map'), organizationAgent: child('organization'),
        historyAgent: child('history'), initialSituationAgent: child('situation'), worldDevelopmentAgent: child('development'), worldSpecificAgent: child('specific') } })
    try { write((await runTurn(initial, `${input.worldIdea}\n\n${input.firstVersionInstruction}`, sampleTimeouts.initialMs, write)).content) }
    finally { await initial.dispose() }

    // 2. 展示总览和已登记成果的实际正文，模拟用户作出第一版完整判断。
    const plans = (await readdir(world.mainAgent.writableRoot)).filter(name => /^world-plan-.*\.md$/.test(name)).sort()
    if (plans.length !== 1) throw new Error(`找到 ${plans.length} 份第一版总览；请检查样例目录，无法自动选择`)
    const overview: DiscussionTarget = { kind: 'file', ownerAgentId: 'main', path: `main/${plans[0]}` }
    const catalog = await readCatalog(world)
    const targets: DiscussionTarget[] = [overview]
    const known = new Set([overview.path])
    for (const record of catalog.records) {
      if (known.has(record.path)) continue
      known.add(record.path); targets.push({ kind: 'file', ownerAgentId: record.ownerAgentId, path: record.path })
    }
    const readArtifacts = async () => Promise.all(targets.map(async target => ({ target, ...(await adapter.read(target)) })))
    write('\n【第二步】展示第一版及资料正文')
    const firstArtifacts = await readArtifacts()
    for (const item of firstArtifacts) write(`\n${JSON.stringify(item.target)}\n${item.content}`)
    write('资料目录不保证包含所有成果；请结合样例目录人工核查遗漏与模型质量。')
    if (input.firstVersionDecision !== '模拟用户确认第一版完整') throw new Error('样例字符串未确认第一版，停止进入讨论')
    write(input.firstVersionDecision)
    const firstId = randomUUID()
    await workflow.confirmFirstVersion({ id: firstId, taskId, createdAt: new Date().toISOString(), actor: 'trusted-workflow',
      scope: '样例模拟第一版判断：总览及已登记成果；目录之外的成果未扫描', artifacts: firstArtifacts.map(({ target, version }) => ({ target, version })) })

    // 3. 针对总览多轮讨论，修改只进入候选。
    write('\n【第三步】讨论总览并形成待审候选')
    const discussion = await workflow.createDiscussion({ taskId, judgmentId: firstId, sessionId: discussionSession, target: overview })
    const discussionAgent = await workflow.startAgentForTask({ taskId, judgmentId: firstId, discussionId: discussion.id,
      session: { sessionRoot, sessionId: discussionSession, sessionMode: 'create' }, options: { mainMaxSteps: 40 } })
    try { write((await runTurn(discussionAgent, input.discussionRequest, sampleTimeouts.discussionMs, write)).content) }
    finally { await discussionAgent.dispose() }
    const discovery = await workflow.discover()
    if (discovery.scopes.some(scope => scope.status !== 'complete') || discovery.issues.length) throw new Error('记录发现不完整或存在身份问题，请检查样例目录')
    const candidates = discovery.entries.filter(entry => entry.kind === 'candidate' && entry.status === 'valid')
      .map(entry => candidateSchema.parse(entry.record)).filter(candidate => candidate.discussionId === discussion.id && candidate.status === 'active')
    if (candidates.length !== 1) throw new Error(`讨论产生 ${candidates.length} 份有效候选；请检查实际记录`)
    const candidate = candidates[0]!

    // 4. 检查可覆盖范围，展示实际差异，再以字符串模拟用户的确认。
    write('\n【第四步】检查影响并审阅候选')
    const report = await workflow.checkImpact(taskId, discussion.id, candidate.id)
    write(JSON.stringify({ status: report.report.status, scopes: report.report.scopes }, null, 2))
    if (report.report.status !== 'completed') throw new Error('影响检查未完成，请检查报告')
    const review = await workflow.createReview(taskId, discussion.id, [report.report.id], { findings: [], dependencies: [] })
    const presented = await workflow.readReview(taskId, discussion.id, review.value.id)
    write(JSON.stringify(presented, null, 2))
    write('此样例没有自动完成跨模块语义冲突判断；空发现不代表不存在冲突。')
    if (input.reviewDecision !== '模拟用户确认所展示的候选并继续' || input.uncoveredDecision !== '模拟用户知悉所列未覆盖范围') throw new Error('样例字符串未确认候选或未覆盖范围，停止发布')
    write(`${input.reviewDecision}；${input.uncoveredDecision}`)
    const uncovered = report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name }))
    const confirmation = await workflow.confirmReview(taskId, discussion.id, review.value.id, { reviewVersion: review.version, confirmContinue: true,
      selectedCandidateIds: [candidate.id], selections: [], acknowledgedUncovered: uncovered })

    // 5. 受控发布总览候选；其他专用模块成果不会作为普通文件修改。
    write('\n【第五步】按确认受控发布')
    const batch = await workflow.submit(taskId, discussion.id, review.value.id, confirmation.version)
    write(JSON.stringify(batch, null, 2))
    if (batch.state !== 'completed') throw new Error('发布未完整完成，请按发布记录核查；不会自动重试')

    // 6. 发布使第一版依据变化，重新读取成果并模拟用户确认，再准备最终交付。
    write('\n【第六步】重新核对资料并准备最终交付')
    const currentArtifacts = await readArtifacts()
    for (const item of currentArtifacts) write(`\n${JSON.stringify(item.target)}\n${item.content}`)
    if (input.firstVersionDecision !== '模拟用户确认第一版完整') throw new Error('样例字符串未重新确认第一版')
    const finalFirstId = randomUUID()
    await workflow.confirmFirstVersion({ id: finalFirstId, taskId, createdAt: new Date().toISOString(), actor: 'trusted-workflow',
      scope: '样例模拟修改后重新判断：总览及已登记成果；目录之外的成果未扫描', artifacts: currentArtifacts.map(({ target, version }) => ({ target, version })) })
    const finalReview = await workflow.prepareDelivery({ id: randomUUID(), taskId, judgmentId: finalFirstId, createdAt: new Date().toISOString(),
      targets, reportIds: [], notes: ['本样例模拟用户确认；未自动完成跨模块语义冲突判断', '资料目录之外的成果未扫描'] })
    write(JSON.stringify(finalReview.value, null, 2))
    if (finalReview.value.deferred.length) throw new Error('仍有活动候选；样例未逐项提供暂留决定，请先核查')
    if (input.deliveryDecision !== '模拟用户确认完成初始化' || input.uncoveredDecision !== '模拟用户知悉所列未覆盖范围') throw new Error('样例字符串未确认最终交付或未覆盖范围')
    write(`${input.deliveryDecision}；${input.uncoveredDecision}`)
    const delivered = await workflow.completeDelivery({ id: randomUUID(), taskId, reviewId: finalReview.value.id, reviewVersion: finalReview.version,
      createdAt: new Date().toISOString(), confirm: true, deferredCandidateIds: [],
      acknowledgedUncovered: finalReview.value.uncovered })
    write(`\n交付记录 ID：${delivered.value.id}`)
    write(`交付记录：${join(roots.delivery, 'deliveries', `${delivered.value.id}.json`)}`)
    write('请人工检查完整性、实际成果和未覆盖范围；本结果不代表真实用户已确认。')
    return { root, worldId: world.worldId, taskId, deliveryId: delivered.value.id }
  } finally {
    await opened?.close()
    await backend.dispose()
  }
}

if (require.main === module) void runWorldInitializationFullExample().catch((error: unknown) => {
  console.error('世界初始化样例停止：', error)
  process.exitCode = 1
})
