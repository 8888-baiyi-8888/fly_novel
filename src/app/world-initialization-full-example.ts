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
import { candidateSchema, discussionSchema, parseDiscussionTarget, type DiscussionTarget, type DiscussionTargetAdapter } from '../world-init/discussion/service.js'
import { withFileDiscussionAdapter } from '../world-init/discussion/file-adapter.js'
import { judgmentSchema } from '../world-init/recovery/task-store.js'
import { impactReportSchema } from '../world-init/impact/service.js'
import { confirmationSchema, reviewSchema } from '../world-init/impact/review.js'
import { batchSchema } from '../world-init/impact/batch-commit.js'
import { inspectInitialSampleResume, sampleOwnerIds, sampleRoots, sampleWorld } from './world-initialization-resume.js'

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
export const sampleTimeouts = { initialMs: 7_200_000, discussionMs: 600_000 }

async function runTurn(agent: Agent, prompt: string, timeoutMs: number, write: (text: string) => void) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('样例超时必须是正整数')
  const stopProgress = observeWorldInitializationProgress(agent, write)
  const timer = setTimeout(() => { write('进度> 已达到本轮超时，正在取消生成；已保存的资料会保留。'); agent.cancel() }, timeoutMs)
  try { return await agent.run({ prompt }) } finally { clearTimeout(timer); stopProgress() }
}

export type WorldInitializationSampleInput = { readonly [K in keyof typeof sampleInput]: string }

const ownerIds = sampleOwnerIds
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
export async function runWorldInitializationFullExample(input: WorldInitializationSampleInput = sampleInput, write: (message: string) => void = console.log,
  options: { readonly resumeRoot?: string } = {}) {
  const resumed = options.resumeRoot ? await inspectInitialSampleResume(options.resumeRoot) : undefined
  const parent = resolve('tmp')
  if (!resumed) await mkdir(parent, { recursive: true })
  const root = resumed?.root ?? await realpath(await mkdtemp(join(parent, 'world-initialization-example-')))
  write(`样例目录：${root}`)
  write('本样例中的用户输入和确认均由文件顶部的字符串模拟，不代表实际用户审阅。')
  if (!resumed) for (const name of subdirectories) await mkdir(join(root, name), { recursive: true })
  const view = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  const world = resumed?.world ?? sampleWorld(root, randomUUID())
  if (!resumed) await initializeCatalog(world.catalogRoot, world.worldId)
  const roots = sampleRoots(root)
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
    const taskId = resumed?.task.id ?? randomUUID(); const initialSession = 'initial'; const discussionSession = 'overview-discussion'
    const prior = resumed ? await workflow.discover() : undefined
    if (resumed && prior) {
      const state = prior
      if (state.scopes.some(scope => scope.status !== 'complete') || state.issues.length ||
          !state.entries.some(entry => entry.kind === 'task' && entry.name === `${taskId}.json` && entry.status === 'valid')) throw new Error('原任务或业务记录无法完整核查，停止续跑')
      if (state.entries.some(entry => entry.kind === 'commit')) throw new Error('发现单项发布记录，样例不能自动判断其结果，请先核查')
      write(`续跑原任务：${taskId}；沿用原世界和会话，不重新创建已有成果。`)
      write(`已暂停可能重复写入的专用 Agent：${ownerIds.filter(owner => !resumed.enabled.has(owner)).join('、') || '无'}。这些模块仍需核查，不能仅凭已有记录判断完成。`)
    } else await workflow.createTask({ id: taskId, sessionIds: [initialSession, discussionSession], createdAt: new Date().toISOString() })

    if (resumed) {
      const deliveries = await readdir(join(roots.delivery, 'deliveries'))
      if (deliveries.length > 1 || deliveries.some(name => !/^[0-9a-f-]{36}\.json$/.test(name))) throw new Error('交付目录存在多份或无法识别的记录，请先核查')
      if (deliveries.length === 1) {
        const delivered = await workflow.readDelivery(deliveries[0]!.slice(0, -5))
        if (delivered.value.taskId !== taskId) throw new Error('交付不属于原任务')
        write(`已有交付记录：${join(roots.delivery, 'deliveries', deliveries[0]!)}；不重复完成。`)
        return { root, worldId: world.worldId, taskId, deliveryId: delivered.value.id }
      }
    }

    // 1. 接收字符串形式的世界构想，装配主 Agent 和全部已有专用 Agent。
    if (!resumed?.hasJudgment) {
      write('\n【第一步】根据世界构想生成第一版')
      const model = await loadConfiguredAdapter('deepseek')
      const enabled = (owner: typeof ownerIds[number]) => !resumed || resumed.enabled.has(owner)
      const child = (agentId: typeof ownerIds[number]) => ({ ...model, agentId, sessionRoot, sessionId: agentId,
        sessionMode: resumed?.modes[agentId] ?? 'create' as const, maxSteps: 30 })
      const initial = await workflow.startAgentForTask({ taskId, session: { sessionRoot, sessionId: initialSession, sessionMode: resumed ? 'resume' : 'create' },
        ...(enabled('characters') ? { characterCreator: { ...child('characters'), initializeCharacters: resumed?.initializeCharacters ?? true, defaultCharacterCount: 1 } } : {}),
        options: { mainMaxSteps: 80, catalog: {}, ...(enabled('basics') ? { worldBasics: child('basics') } : {}),
          ...(enabled('map') ? { mapAgent: child('map') } : {}), ...(enabled('organization') ? { organizationAgent: child('organization') } : {}),
          ...(enabled('history') ? { historyAgent: child('history') } : {}), ...(enabled('situation') ? { initialSituationAgent: child('situation') } : {}),
          ...(enabled('development') ? { worldDevelopmentAgent: child('development') } : {}), ...(enabled('specific') ? { worldSpecificAgent: child('specific') } : {}) } })
      const prompt = resumed
        ? '继续原来的世界初始化。先读取并核实已有资料与目录，保留已有成果，不重复创建；不要把会话或目录当作任务完成的证明。尚未装配写入工具的模块只能报告实际情况和未完成范围。仅在完整第一版形成后保存总览；无法核实完整时停下并报告。'
        : `${input.worldIdea}\n\n${input.firstVersionInstruction}`
      try { write((await runTurn(initial, prompt, sampleTimeouts.initialMs, write)).content) }
      finally { await initial.dispose() }
    }

    // 2. 展示总览和已登记成果的实际正文，模拟用户作出第一版完整判断。
    const plans = (await readdir(world.mainAgent.writableRoot)).filter(name => /^world-plan-.*\.md$/.test(name)).sort()
    if (plans.length !== 1) throw new Error(`找到 ${plans.length} 份第一版总览；请检查样例目录，无法自动选择`)
    const overview: DiscussionTarget = { kind: 'file', ownerAgentId: 'main', path: `main/${plans[0]}` }
    const judgments = (prior?.entries ?? []).filter(entry => entry.kind === 'judgment' && entry.status === 'valid').map(entry => judgmentSchema.parse(entry.record))
    if (judgments.some(item => item.taskId !== taskId)) throw new Error('第一版判断不属于原任务')
    const firstJudgments = judgments.filter(item => item.scope.startsWith('样例模拟第一版判断：'))
    const finalJudgments = judgments.filter(item => item.scope.startsWith('样例模拟修改后重新判断：'))
    if (firstJudgments.length > 1 || finalJudgments.length > 1 || judgments.length !== firstJudgments.length + finalJudgments.length) throw new Error('第一版判断不唯一或无法识别，请先核查')
    if (resumed?.hasJudgment && firstJudgments.length !== 1) throw new Error('缺少可识别的原第一版判断，请先核查')
    if (firstJudgments[0] && !firstJudgments[0].artifacts.some(item => JSON.stringify(parseDiscussionTarget(item.target)) === JSON.stringify(overview))) throw new Error('第一版判断与总览身份不匹配')
    const catalog = await readCatalog(world)
    const targets: DiscussionTarget[] = [overview]
    const known = new Set([overview.path])
    if (firstJudgments[0]) {
      for (const artifact of firstJudgments[0].artifacts) {
        const target = parseDiscussionTarget(artifact.target)
        if (target.kind !== 'file') throw new Error('样例第一版包含不支持的目标')
        if (known.has(target.path)) continue
        known.add(target.path); targets.push(target)
      }
    } else for (const record of catalog.records) {
      if (!known.has(record.path)) { known.add(record.path); targets.push({ kind: 'file', ownerAgentId: record.ownerAgentId, path: record.path }) }
    }
    const readArtifacts = async () => Promise.all(targets.map(async target => ({ target, ...(await adapter.read(target)) })))
    write('\n【第二步】展示第一版及资料正文')
    const firstArtifacts = await readArtifacts()
    for (const item of firstArtifacts) write(`\n${JSON.stringify(item.target)}\n${item.content}`)
    write('资料目录不保证包含所有成果；请结合样例目录人工核查遗漏与模型质量。')
    if (input.firstVersionDecision !== '模拟用户确认第一版完整') throw new Error('样例字符串未确认第一版，停止进入讨论')
    write(input.firstVersionDecision)
    const firstId = firstJudgments[0]?.id ?? randomUUID()
    if (!firstJudgments[0]) await workflow.confirmFirstVersion({ id: firstId, taskId, createdAt: new Date().toISOString(), actor: 'trusted-workflow',
      scope: '样例模拟第一版判断：总览及已登记成果；目录之外的成果未扫描', artifacts: firstArtifacts.map(({ target, version }) => ({ target, version })) })

    // 3. 针对总览多轮讨论，修改只进入候选。
    write('\n【第三步】讨论总览并形成待审候选')
    const previousDiscussions = (prior?.entries ?? []).filter(entry => entry.kind === 'discussion' && entry.status === 'valid').map(entry => discussionSchema.parse(entry.record))
    if (previousDiscussions.length > 1 || previousDiscussions.some(item => item.sessionId !== discussionSession || JSON.stringify(item.target) !== JSON.stringify(overview))) throw new Error('讨论记录不唯一或目标不匹配，请先核查')
    if (!firstJudgments[0] && previousDiscussions.length) throw new Error('讨论存在但缺少原第一版判断')
    const discussion = previousDiscussions[0] ?? await workflow.createDiscussion({ taskId, judgmentId: firstId, sessionId: discussionSession, target: overview })
    const previousCandidates = (prior?.entries ?? []).filter(entry => entry.kind === 'candidate' && entry.status === 'valid').map(entry => candidateSchema.parse(entry.record))
    if (previousCandidates.length > 1 || previousCandidates.some(item => item.discussionId !== discussion.id)) throw new Error('候选记录不唯一或不属于原讨论，请先核查')
    if (!previousCandidates.length) {
      if (resumed?.discussionSessionExists) throw new Error('原讨论 Session 已存在但没有可核查候选；为避免重复生成，请先核查')
      const discussionAgent = await workflow.startAgentForTask({ taskId, judgmentId: firstId, discussionId: discussion.id,
        session: { sessionRoot, sessionId: discussionSession, sessionMode: 'create' }, options: { mainMaxSteps: 40 } })
      try { write((await runTurn(discussionAgent, input.discussionRequest, sampleTimeouts.discussionMs, write)).content) }
      finally { await discussionAgent.dispose() }
    } else write(`复用已有候选：${previousCandidates[0]!.id}，状态 ${previousCandidates[0]!.status}。`)
    const discovery = await workflow.discover()
    if (discovery.scopes.some(scope => scope.status !== 'complete') || discovery.issues.length) throw new Error('记录发现不完整或存在身份问题，请检查样例目录')
    const candidates = discovery.entries.filter(entry => entry.kind === 'candidate' && entry.status === 'valid')
      .map(entry => candidateSchema.parse(entry.record)).filter(candidate => candidate.discussionId === discussion.id)
    if (candidates.length !== 1 || !['active', 'committed'].includes(candidates[0]!.status)) throw new Error('候选数量或状态不适合自动继续；请先核查')
    const candidate = candidates[0]!

    // 4. 检查可覆盖范围，展示实际差异，再以字符串模拟用户的确认。
    write('\n【第四步】检查影响并审阅候选')
    const reportEntries = discovery.entries.filter(entry => entry.kind === 'impact' && entry.status === 'valid')
    if (reportEntries.length > 1 || reportEntries.some(entry => impactReportSchema.parse(entry.record).candidateId !== candidate.id)) throw new Error('影响报告不唯一或不属于原候选，请先核查')
    const report = reportEntries[0] ? { report: impactReportSchema.parse(reportEntries[0].record), version: reportEntries[0].version! }
      : await workflow.checkImpact(taskId, discussion.id, candidate.id)
    write(JSON.stringify({ status: report.report.status, scopes: report.report.scopes }, null, 2))
    if (report.report.status !== 'completed') throw new Error('影响检查未完成，请检查报告')
    const reviewEntries = discovery.entries.filter(entry => entry.kind === 'review' && entry.status === 'valid')
    if (reviewEntries.length > 1) throw new Error('存在多份审阅，请先选择并核查')
    const review = reviewEntries[0] ? { value: reviewSchema.parse(reviewEntries[0].record), version: reviewEntries[0].version! }
      : await workflow.createReview(taskId, discussion.id, [report.report.id], { findings: [], dependencies: [] })
    if (review.value.discussionId !== discussion.id || review.value.reports.length !== 1 || review.value.reports[0]!.report.id !== report.report.id ||
        review.value.reports[0]!.version !== report.version || JSON.stringify(review.value.reports[0]!.report) !== JSON.stringify(report.report) ||
        review.value.findings.length || review.value.dependencies.length) throw new Error('审阅与样例报告不一致或包含待处理发现，请先核查')
    const presented = await workflow.readReview(taskId, discussion.id, review.value.id)
    write(JSON.stringify(presented, null, 2))
    write('此样例没有自动完成跨模块语义冲突判断；空发现不代表不存在冲突。')
    if (input.reviewDecision !== '模拟用户确认所展示的候选并继续' || input.uncoveredDecision !== '模拟用户知悉所列未覆盖范围') throw new Error('样例字符串未确认候选或未覆盖范围，停止发布')
    write(`${input.reviewDecision}；${input.uncoveredDecision}`)
    const uncovered = report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name }))
    const confirmationEntries = discovery.entries.filter(entry => entry.kind === 'confirmation' && entry.status === 'valid')
    if (confirmationEntries.length > 1) throw new Error('存在多份确认，请先核查')
    const confirmation = confirmationEntries[0] ? { value: confirmationSchema.parse(confirmationEntries[0].record), version: confirmationEntries[0].version! }
      : await workflow.confirmReview(taskId, discussion.id, review.value.id, { reviewVersion: review.version, confirmContinue: true,
        selectedCandidateIds: [candidate.id], selections: [], acknowledgedUncovered: uncovered })
    if (confirmation.value.reviewId !== review.value.id || confirmation.value.discussionId !== discussion.id || confirmation.value.reviewVersion !== review.version ||
        confirmation.value.selectedCandidateIds.length !== 1 || confirmation.value.selectedCandidateIds[0] !== candidate.id || confirmation.value.choices.length ||
        JSON.stringify([...confirmation.value.acknowledgedUncovered].map(item => JSON.stringify(item)).sort()) !== JSON.stringify(uncovered.map(item => JSON.stringify(item)).sort())) throw new Error('确认与原审阅不一致，请先核查')

    // 5. 受控发布总览候选；其他专用模块成果不会作为普通文件修改。
    write('\n【第五步】按确认受控发布')
    const batchEntries = discovery.entries.filter(entry => entry.kind === 'batch' && entry.status === 'valid')
    if (batchEntries.length > 1) throw new Error('存在多份发布记录，请先核查')
    if (finalJudgments.length && !batchEntries.length) throw new Error('存在修改后判断但缺少原发布记录，请先核查')
    let batch
    if (batchEntries[0]) {
      batch = batchSchema.parse(batchEntries[0].record)
      const item = batch.items[0]
      if (batch.id !== review.value.id || batch.discussionId !== discussion.id || batch.state !== 'completed' || batch.items.length !== 1 ||
          !item || item.candidateId !== candidate.id || item.phase !== 'committed' || item.catalogStatus === 'failed' || item.catalogStatus === 'pending' || candidate.status !== 'committed') {
        throw new Error('发布未完成或结果不确定，请通过恢复接口核查，不会自动重试')
      }
      const actual = await adapter.read(overview)
      if (actual.version !== item.afterVersion || actual.content !== candidate.content) throw new Error('已发布正文发生变化，请先核查')
      write('原发布记录已完成并核对当前正文，不重复发布。')
    } else {
      if (candidate.status !== 'active') throw new Error('候选已提交但缺少发布记录，请先核查')
      batch = await workflow.submit(taskId, discussion.id, review.value.id, confirmation.version)
    }
    write(JSON.stringify(batch, null, 2))
    if (batch.state !== 'completed') throw new Error('发布未完整完成，请按发布记录核查；不会自动重试')

    // 6. 发布使第一版依据变化，重新读取成果并模拟用户确认，再准备最终交付。
    write('\n【第六步】重新核对资料并准备最终交付')
    const currentArtifacts = await readArtifacts()
    for (const item of currentArtifacts) write(`\n${JSON.stringify(item.target)}\n${item.content}`)
    if (input.firstVersionDecision !== '模拟用户确认第一版完整') throw new Error('样例字符串未重新确认第一版')
    const finalFirstId = finalJudgments[0]?.id ?? randomUUID()
    if (finalJudgments[0]) {
      const existing = await workflow.readFirstVersion(taskId, finalFirstId)
      if (existing.artifacts.some(item => item.status !== 'current')) throw new Error('修改后的第一版判断已失效，请先核查')
      write('复用已保存的第一版重新判断。')
    } else await workflow.confirmFirstVersion({ id: finalFirstId, taskId, createdAt: new Date().toISOString(), actor: 'trusted-workflow',
      scope: '样例模拟修改后重新判断：总览及已登记成果；目录之外的成果未扫描', artifacts: currentArtifacts.map(({ target, version }) => ({ target, version })) })
    const previousDeliveryReviews = await readdir(join(roots.delivery, 'reviews'))
    if (previousDeliveryReviews.length) throw new Error('已有最终交付审阅但没有可核查交付记录；结果可能不确定，请先核查，不自动重复完成')
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

if (require.main === module) {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--resume' || !args[1])) {
    console.error('用法：pnpm run world-initialization-full-example -- --resume "已有样例目录的绝对路径"')
    process.exitCode = 1
  } else void runWorldInitializationFullExample(sampleInput, console.log, args.length ? { resumeRoot: args[1] } : {}).catch((error: unknown) => {
  console.error('世界初始化样例停止：', error)
  process.exitCode = 1
  })
}
