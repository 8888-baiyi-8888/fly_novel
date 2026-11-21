import { createHash } from 'node:crypto'
import type { SessionPersistence } from '@fly-novel/session-persistence'
import type { WorldAccess } from '@fly-novel/util'
import { parseDiscussionTarget, type DiscussionService, type DiscussionTarget } from '../discussion/service.js'
import type { WorldCommitService } from '../impact/commit.js'
import type { BatchCommitService } from '../impact/batch-commit.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import { mainSessionPersistenceId } from './main-session-id.js'
import type { InitializationTaskStore } from './task-store.js'

const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000)
type Observation = { readonly status: 'read'; readonly content: string; readonly version: string; readonly digest: string } |
  { readonly status: 'failed'; readonly error: string }
type Decision = { readonly kind: 'accept-result' | 'accept-baseline'; readonly observedVersion: string }

/** 可信恢复装配。观察不会调用可能修改人物索引、候选或发布记录的恢复接口。 */
export class InitializationRecovery {
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly gate: WorldAccess, private readonly discussions: DiscussionService,
    private readonly tasks: InitializationTaskStore, private readonly single?: WorldCommitService,
    private readonly batch?: BatchCommitService, private readonly sessions?: SessionPersistence) {}

  static async create(options: { worlds: readonly WorldWorkspaceConfig[]; worldId: string; gate: WorldAccess;
    discussions: DiscussionService; tasks: InitializationTaskStore; single?: WorldCommitService; batch?: BatchCommitService;
    sessions?: SessionPersistence }): Promise<InitializationRecovery> {
    const worlds = await validateWorldWorkspaceConfigs(options.worlds)
    const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || !options.tasks.isBoundToRecovery(world, options.gate) || !options.discussions.isBoundToWorld(world) || !options.gate.covers(world.readRoot) ||
      (options.single && !options.single.isBoundToRecovery(world, options.gate, options.discussions)) ||
      (options.batch && !options.batch.isBoundToRecovery(world, options.gate, options.discussions))) throw new Error('恢复服务世界或协调绑定不匹配')
    return new InitializationRecovery(world, options.gate, options.discussions, options.tasks, options.single, options.batch, options.sessions)
  }
  isBoundTo(world: WorldWorkspaceConfig, gate: WorldAccess, tasks: InitializationTaskStore, discussions: DiscussionService, batch: BatchCommitService): boolean {
    return this.world.worldId === world.worldId && this.gate === gate && this.tasks === tasks && this.discussions === discussions && this.batch === batch
  }
  private async observe(discussionId: string, candidateId: string, target: DiscussionTarget) {
    let current: Observation
    try { const value = await this.discussions.readRelated(discussionId, target); current = { status: 'read', ...value, digest: digest(value.content) } }
    catch (error) { current = { status: 'failed', error: errorText(error) } }
    let candidate: { status: 'read'; value: Awaited<ReturnType<DiscussionService['readCandidate']>> } | { status: 'failed'; error: string }
    try { candidate = { status: 'read', value: await this.discussions.readCandidate(candidateId) } }
    catch (error) { candidate = { status: 'failed', error: errorText(error) } }
    return { current, candidate }
  }
  /** 返回发布记录、当前正文和候选的实际观察；失败不等于不存在。 */
  inspectSingle(id: string) {
    if (!this.single) throw new Error('未装配单项发布服务')
    const service = this.single
    return this.gate.run(async () => {
      const record = await service.inspect(id)
      const observed = await this.observe(record.value.discussionId, record.value.candidateId, record.value.target)
      return { record, observed, limitation: '记录阶段与正文观察不能单独证明发布是否发生；结果不确定时需用户核对。' }
    })
  }
  /** 返回批次的每项目标观察；未开始和已发布项不会被误认为整体回滚。 */
  inspectBatch(id: string) {
    if (!this.batch) throw new Error('未装配批次发布服务')
    const service = this.batch
    return this.gate.run(async () => {
      const record = await service.inspect(id); const items = []
      for (const item of record.value.items) items.push({ candidateId: item.candidateId, phase: item.phase,
        observed: await this.observe(record.value.discussionId, item.candidateId, parseDiscussionTarget(item.target)) })
      return { record, items, limitation: '各项记录和观察需分别核对；后续目标必须重新检查和确认。' }
    })
  }
  /** 仅接收用户明确发起的动作和刚展示的记录版本，不自动重放发布。 */
  reconcileSingle(input: { id: string; expectedVersion: string; decision?: Decision }) {
    if (!this.single) throw new Error('未装配单项发布服务')
    const service = this.single
    return this.gate.run(async () => {
      if ((await service.inspect(input.id)).version !== input.expectedVersion) throw new Error('发布记录已变化，请重新核查')
      return service.reconcile(input.id, input.decision)
    })
  }
  stopBatch(input: { id: string; expectedVersion: string }) {
    if (!this.batch) throw new Error('未装配批次发布服务')
    const service = this.batch
    return this.gate.run(async () => {
      if ((await service.inspect(input.id)).version !== input.expectedVersion) throw new Error('批次记录已变化，请重新核查')
      return service.stopAfterInterrupt(input.id)
    })
  }
  reconcileBatchItem(input: { id: string; candidateId: string; expectedVersion: string; decision?: Decision }) {
    if (!this.batch) throw new Error('未装配批次发布服务')
    const service = this.batch
    return this.gate.run(async () => {
      if ((await service.inspect(input.id)).version !== input.expectedVersion) throw new Error('批次记录已变化，请重新核查')
      return service.reconcileItem(input.id, input.candidateId, input.decision)
    })
  }
  /** 只打开可信任务所关联的 Session，调用方负责关闭返回的只读句柄。 */
  async openSession(taskId: string, sessionId: string, mode: 'initialization' | 'discussion') {
    if (!this.sessions) throw new Error('未装配 Session 持久化服务')
    const task = await this.tasks.readTask(taskId)
    if (!task.value.sessionIds.includes(sessionId)) throw new Error('Session 不属于所选任务')
    return this.sessions.open(mainSessionPersistenceId(this.world.worldId, this.world.mainAgent.agentId, sessionId, mode), 'read')
  }
}
