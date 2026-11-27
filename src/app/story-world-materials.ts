import { createHash } from 'node:crypto'
import type { WorldInitializationWorkflow } from './world-initialization-workflow.js'
import { parseDiscussionTarget, type DiscussionTarget } from '../world-init/discussion/service.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../world-init/workspace/config.js'

/** 使用可信应用选定的交付与目标范围。初始化应用句柄由调用方持有和关闭。 */
export async function bindStoryWorld(options: {
  readonly worlds: readonly WorldWorkspaceConfig[]
  readonly worldId: string
  readonly initialization: WorldInitializationWorkflow
  readonly deliveryId: string
  readonly targets: readonly DiscussionTarget[]
}) {
  const worlds = await validateWorldWorkspaceConfigs(options.worlds)
  const world = worlds.find(item => item.worldId === options.worldId)
  if (!world) throw new Error('故事世界配置不存在')
  const read = options.initialization.bindDeliveryReader(world)
  const key = (target: unknown) => JSON.stringify(parseDiscussionTarget(target))
  const allowed = new Set(options.targets.map(key))
  if (!allowed.size || allowed.size !== options.targets.length) throw new Error('故事交付读取范围为空或目标重复')
  const deliveryId = options.deliveryId

  return Object.freeze({
    world,
    deliveryId,
    /** 重读获准目标的历史正文。授权之外和交付未覆盖分别拒绝。 */
    async readDelivery(targets: readonly DiscussionTarget[]) {
      const requested = [...new Set(targets.map(key))]
      if (requested.length === 0 || requested.some(target => !allowed.has(target))) throw new Error('无权读取所选交付目标')
      const { value, version } = await read(deliveryId)
      const { review } = value
      if (review.id !== value.reviewId || review.taskId !== value.taskId || review.worldId !== world.worldId) {
        throw new Error('交付审阅身份不匹配')
      }
      const artifacts = requested.map(target => {
        const matching = review.artifacts.filter(item => key(item.target) === target)
        const [item] = matching
        if (!item) throw new Error(`交付未覆盖目标 ${target}`)
        if (matching.length !== 1 || createHash('sha256').update(item.content).digest('hex') !== item.digest) {
          throw new Error(`交付正文重复或摘要不匹配 ${target}`)
        }
        return { ...item, target: parseDiscussionTarget(item.target) }
      })
      return {
        worldId: world.worldId, deliveryId, version, formatVersion: value.formatVersion, reviewVersion: value.reviewVersion,
        artifacts, deferred: review.deferred.filter(item => requested.includes(key(item.target))).map(item => ({ ...item, target: parseDiscussionTarget(item.target) })),
        notes: review.notes, uncovered: review.uncovered, acknowledgedUncovered: value.acknowledgedUncovered,
      }
    },
  })
}
