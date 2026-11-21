import type { Agent } from '@fly-novel/agents'
import type { WorldAccess } from '@fly-novel/util'
import type { WorldWorkspaceConfig } from '../world-init/workspace/config.js'
import { validateWorldWorkspaceConfigs } from '../world-init/workspace/config.js'
import type { DiscussionService, DiscussionTarget } from '../world-init/discussion/service.js'
import type { ImpactService } from '../world-init/impact/service.js'
import type { ReviewService } from '../world-init/impact/review.js'
import type { BatchCommitService } from '../world-init/impact/batch-commit.js'
import { discoverInitialization, type DiscoveryRoot } from '../world-init/recovery/discovery.js'
import type { InitializationTaskStore } from '../world-init/recovery/task-store.js'
import type { InitializationDelivery } from '../world-init/recovery/delivery.js'
import type { InitializationRecovery } from '../world-init/recovery/orchestrator.js'
import { createWorldInitializationAgentWithWorldWorkspaces, type WorkspaceCharacterCreatorConfig, type WorldInitializationSessionConfig } from './agents/world-initialization.js'
import { readWorldReview } from './world-review.js'

type Deployment = Parameters<typeof createWorldInitializationAgentWithWorldWorkspaces>[3]
const samePath = (left: string | undefined, right: string) => left !== undefined && (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right)

type AgentOptions = Omit<Deployment, 'singleWriterProcess' | 'discussion' | 'mainSession'>

/** 可信应用入口；借用业务服务，不将用户确认和发布接口注册给模型。 */
export class WorldInitializationWorkflow {
  private readonly agents = new Set<Agent>()
  private readonly starting = new Set<Promise<Agent>>()
  private closing?: Promise<void>
  private constructor(private readonly worlds: readonly WorldWorkspaceConfig[], private readonly worldId: string,
    private readonly roots: Partial<Record<DiscoveryRoot, string>>, private readonly sessionRoots: readonly string[],
    private readonly gate: WorldAccess, private readonly tasks: InitializationTaskStore, private readonly discussions: DiscussionService,
    private readonly impact: ImpactService, private readonly review: ReviewService, private readonly batch: BatchCommitService,
    readonly recovery: InitializationRecovery, private readonly delivery: InitializationDelivery) {}

  static async create(options: { worlds: readonly WorldWorkspaceConfig[]; worldId: string; roots: Partial<Record<DiscoveryRoot, string>>;
    sessionRoots: readonly string[]; gate: WorldAccess; tasks: InitializationTaskStore; discussions: DiscussionService;
    impact: ImpactService; review: ReviewService; batch: BatchCommitService; recovery: InitializationRecovery; delivery: InitializationDelivery }) {
    const worlds = await validateWorldWorkspaceConfigs(options.worlds)
    const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || !options.tasks.isBoundToRecovery(world, options.gate) || !options.discussions.isBoundToWorld(world) ||
      !options.impact.isBoundToWorld(world) || !options.impact.isBoundTo(options.discussions) || !options.review.isBoundToWorld(world) ||
      !options.review.isBoundTo(options.discussions, options.impact) || !options.batch.isBoundToRecovery(world, options.gate, options.discussions) || !options.recovery.isBoundTo(world, options.gate, options.tasks, options.discussions, options.batch) || !options.delivery.isBoundTo(world, options.gate, options.tasks, options.impact)) throw new Error('应用服务世界或协调绑定不匹配')
    if (!samePath(options.roots.task, options.tasks.rootDirectory) || !samePath(options.roots.discussion, options.discussions.rootDirectory) ||
      !samePath(options.roots.impact, options.impact.rootDirectory) || !samePath(options.roots.review, options.review.rootDirectory) || !samePath(options.roots.batch, options.batch.rootDirectory) || !samePath(options.roots.delivery, options.delivery.rootDirectory)) throw new Error('应用业务根与服务不匹配')
    await discoverInitialization({ worlds, worldId: options.worldId, roots: options.roots, sessionRoots: options.sessionRoots })
    return new WorldInitializationWorkflow(worlds, options.worldId, { ...options.roots }, [...options.sessionRoots], options.gate,
      options.tasks, options.discussions, options.impact, options.review, options.batch, options.recovery, options.delivery)
  }
  private check(): void { if (this.closing) throw new Error('初始化应用已关闭') }
  discover() { this.check(); return discoverInitialization({ worlds: this.worlds, worldId: this.worldId, roots: this.roots, sessionRoots: this.sessionRoots }) }
  createTask(input: Parameters<InitializationTaskStore['createTask']>[0]) { this.check(); return this.tasks.createTask(input) }
  confirmFirstVersion(input: Parameters<InitializationTaskStore['confirmFirstVersion']>[0]) { this.check(); return this.tasks.confirmFirstVersion(input) }
  readFirstVersion(taskId: string, judgmentId: string) { this.check(); return this.tasks.readFirstVersion(taskId, judgmentId) }
  private async authorizeSession(taskId: string, sessionId: string) {
    const task = await this.tasks.readTask(taskId)
    if (!task.value.sessionIds.includes(sessionId)) throw new Error('Session 不属于所选任务')
  }
  private async requireFirstVersion(taskId: string, judgmentId: string) {
    const judgment = await this.tasks.readFirstVersion(taskId, judgmentId)
    if (judgment.artifacts.some(item => item.status !== 'current')) throw new Error('第一版依据已变化或不可读取，请重新判断')
  }
  createDiscussion(input: { taskId: string; judgmentId: string; sessionId: string; target: DiscussionTarget }) {
    this.check()
    return this.gate.run(async () => {
      await this.authorizeSession(input.taskId, input.sessionId); await this.requireFirstVersion(input.taskId, input.judgmentId)
      return this.discussions.createDiscussion(input.target, input.sessionId)
    })
  }
  private async discussionForTask(taskId: string, discussionId: string) {
    const discussion = await this.discussions.readDiscussion(discussionId)
    await this.authorizeSession(taskId, discussion.sessionId)
    return discussion
  }
  private startAgent(promise: Promise<Agent>): Promise<Agent> {
    this.starting.add(promise)
    return promise.then(agent => { this.agents.add(agent); return agent }).finally(() => { this.starting.delete(promise) })
  }
  /** 启动初始化或讨论 Agent；应用负责其取消和关闭。 */
  startAgentForTask(input: { taskId: string; session: WorldInitializationSessionConfig; judgmentId?: string; discussionId?: string;
    additionalTargets?: readonly DiscussionTarget[]; characterCreator?: WorkspaceCharacterCreatorConfig; options?: AgentOptions }) {
    this.check()
    const start = (async () => {
      if (!this.sessionRoots.some(root => samePath(root, input.session.sessionRoot))) throw new Error('主 Session 根不在可信应用配置中')
      const delegated = [input.characterCreator, input.options?.worldBasics, input.options?.mapAgent, input.options?.organizationAgent,
        input.options?.historyAgent, input.options?.initialSituationAgent, input.options?.worldDevelopmentAgent, input.options?.worldSpecificAgent]
      for (const agent of delegated) if (agent && !this.sessionRoots.some(root => samePath(root, agent.sessionRoot))) throw new Error('子 Agent Session 根不在可信应用配置中')
      await this.authorizeSession(input.taskId, input.session.sessionId)
      if (input.discussionId) {
        if (!input.judgmentId) throw new Error('讨论需要第一版完整判断')
        const discussion = await this.discussionForTask(input.taskId, input.discussionId)
        if (discussion.sessionId !== input.session.sessionId) throw new Error('讨论 Session 不匹配')
        await this.requireFirstVersion(input.taskId, input.judgmentId)
      } else if (input.judgmentId || input.additionalTargets?.length) throw new Error('初始化模式不能指定讨论目标或判断')
      return createWorldInitializationAgentWithWorldWorkspaces(this.worlds, this.worldId, input.characterCreator,
        { ...input.options, singleWriterProcess: true, mainSession: input.session,
          ...(input.discussionId ? { discussion: { firstVersionComplete: true, binding: { service: this.discussions, discussionId: input.discussionId,
            additionalTargets: input.additionalTargets, impact: this.impact } } } : {}) })
    })()
    return this.startAgent(start)
  }
  checkImpact(taskId: string, discussionId: string, candidateId: string, signal?: AbortSignal) {
    this.check(); return this.gate.run(async () => { await this.discussionForTask(taskId, discussionId); return this.impact.check(discussionId, candidateId, signal) })
  }
  createReview(taskId: string, discussionId: string, reportIds: readonly string[], input: Parameters<ReviewService['create']>[2]) {
    this.check(); return this.gate.run(async () => { await this.discussionForTask(taskId, discussionId); return this.review.create(discussionId, reportIds, input) })
  }
  readReview(taskId: string, discussionId: string, reviewId: string) {
    this.check(); return this.gate.run(async () => { await this.discussionForTask(taskId, discussionId); return readWorldReview(this.review, discussionId, reviewId) })
  }
  confirmReview(taskId: string, discussionId: string, reviewId: string, input: Parameters<ReviewService['confirm']>[2]) {
    this.check(); return this.gate.run(async () => { await this.discussionForTask(taskId, discussionId); return this.review.confirm(discussionId, reviewId, input) })
  }
  submit(taskId: string, discussionId: string, reviewId: string, confirmationVersion: string, signal?: AbortSignal) {
    this.check(); return this.gate.run(async () => { await this.discussionForTask(taskId, discussionId); return this.batch.submit(discussionId, reviewId, confirmationVersion, signal) })
  }
  prepareDelivery(input: Parameters<InitializationDelivery['prepare']>[0]) { this.check(); return this.delivery.prepare(input) }
  readDeliveryReview(id: string) { this.check(); return this.delivery.readReview(id) }
  completeDelivery(input: Parameters<InitializationDelivery['complete']>[0]) { this.check(); return this.delivery.complete(input) }
  readDelivery(id: string) { this.check(); return this.delivery.readDelivery(id) }
  cancel(): void { for (const agent of this.agents) agent.cancel() }
  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      await Promise.allSettled([...this.starting]); this.cancel()
      const results = await Promise.allSettled([...this.agents].map(agent => agent.dispose()))
      const errors = results.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length) throw new AggregateError(errors, '初始化 Agent 清理失败')
      this.agents.clear()
    })()
    return this.closing
  }
}
