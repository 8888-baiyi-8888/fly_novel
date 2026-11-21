import type { LocalFileSystem } from '@fly-novel/fs-local'
import type { SessionPersistence } from '@fly-novel/session-persistence'
import { WorldAccess } from '@fly-novel/util'
import type { WorldWorkspaceConfig } from '../world-init/workspace/config.js'
import { validateWorldWorkspaceConfigs } from '../world-init/workspace/config.js'
import { DiscussionService, type DiscussionTargetAdapter } from '../world-init/discussion/service.js'
import { ImpactService } from '../world-init/impact/service.js'
import { ReviewService } from '../world-init/impact/review.js'
import { WorldCommitService } from '../world-init/impact/commit.js'
import { BatchCommitService } from '../world-init/impact/batch-commit.js'
import { TargetPublisher } from '../world-init/impact/target-publisher.js'
import { discoverInitialization } from '../world-init/recovery/discovery.js'
import { InitializationTaskStore } from '../world-init/recovery/task-store.js'
import { InitializationRecovery } from '../world-init/recovery/orchestrator.js'
import { WorldInitializationWorkflow } from './world-initialization-workflow.js'

type Roots = { readonly task: string; readonly discussion: string; readonly impact: string; readonly review: string; readonly commit: string; readonly batch: string }
type ImpactOptions = Pick<Parameters<typeof ImpactService.open>[0], 'map' | 'history' | 'organization'>
type SingleOptions = Pick<Parameters<typeof WorldCommitService.open>[0], 'map' | 'characters'>
type PublisherOptions = Parameters<typeof TargetPublisher.create>[2]

/** 装配单个可信世界；文件后端、模块存储与 Session 服务由调用方借出。 */
export async function openWorldInitializationWorkflow(options: { readonly worlds: readonly WorldWorkspaceConfig[]; readonly worldId: string;
  readonly roots: Roots; readonly sessionRoots: readonly string[]; readonly fs: LocalFileSystem; readonly adapter: DiscussionTargetAdapter;
  readonly impact?: ImpactOptions; readonly publisher: PublisherOptions; readonly single?: SingleOptions; readonly sessions?: SessionPersistence;
  readonly singleWriterProcess: true }) {
  if (options.singleWriterProcess !== true) throw new Error('必须保证单可信写入进程')
  const worlds = await validateWorldWorkspaceConfigs(options.worlds)
  const world = worlds.find(item => item.worldId === options.worldId)
  if (!world) throw new Error('世界配置不存在')
  await discoverInitialization({ worlds, worldId: world.worldId, roots: options.roots, sessionRoots: options.sessionRoots })
  const gate = WorldAccess.register([world.readRoot, ...Object.values(options.roots)])
  const cleanups: Array<() => Promise<void>> = []
  let workflow: WorldInitializationWorkflow | undefined
  let closing: Promise<void> | undefined
  const cleanup = async () => {
    const errors: unknown[] = []
    if (workflow) try { await workflow.close() } catch (error) { throw new AggregateError([error], 'Agent 清理失败；业务资源及协调占用保留') }
    for (const close of [...cleanups].reverse()) try { await close() } catch (error) { errors.push(error) }
    if (!errors.length) try { await gate.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '初始化应用资源清理失败；协调占用保留')
  }
  try {
    const discussion = await DiscussionService.open({ worldId: world.worldId, root: options.roots.discussion, worldRoots: worlds.map(item => item.readRoot),
      fs: options.fs, adapter: options.adapter, singleWriterProcess: true }); cleanups.push(() => discussion.close())
    const impact = await ImpactService.open({ ...options.impact, workspaces: worlds, worldId: world.worldId, root: options.roots.impact,
      fs: options.fs, discussion, singleWriterProcess: true }); cleanups.push(() => impact.close())
    const review = await ReviewService.open({ workspaces: worlds, worldId: world.worldId, root: options.roots.review, fs: options.fs,
      discussion, impact, singleWriterProcess: true }); cleanups.push(() => review.close())
    const publisher = await TargetPublisher.create(world, options.fs, options.publisher)
    const batch = await BatchCommitService.open({ workspaces: worlds, worldId: world.worldId, root: options.roots.batch, fs: options.fs,
      gate, discussion, impact, review, publisher, sessionRoots: options.sessionRoots, singleWriterProcess: true }); cleanups.push(() => batch.close())
    const single = await WorldCommitService.open({ ...options.single, workspaces: worlds, worldId: world.worldId, root: options.roots.commit,
      fs: options.fs, gate, discussion, impact, review, sessionRoots: options.sessionRoots, singleWriterProcess: true }); cleanups.push(() => single.close())
    const tasks = await InitializationTaskStore.open({ worlds, worldId: world.worldId, root: options.roots.task,
      otherRoots: [options.roots.discussion, options.roots.impact, options.roots.review, options.roots.commit, options.roots.batch, ...options.sessionRoots],
      fs: options.fs, gate, adapter: options.adapter, singleWriterProcess: true }); cleanups.push(() => tasks.close())
    const recovery = await InitializationRecovery.create({ worlds, worldId: world.worldId, gate, discussions: discussion, tasks, batch, single, sessions: options.sessions })
    workflow = await WorldInitializationWorkflow.create({ worlds, worldId: world.worldId, roots: options.roots, sessionRoots: options.sessionRoots,
      gate, tasks, discussions: discussion, impact, review, batch, recovery })
    return { workflow, close: () => { if (!closing) closing = cleanup(); return closing } }
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], '初始化应用启动和清理失败') }
    throw error
  }
}
