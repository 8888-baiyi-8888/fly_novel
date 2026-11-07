import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@fly-novel/fs'
import type { FsObservation, FsTarget, FsWriteIntent, FsVersion } from '@fly-novel/fs'
import type { ToolRunContext } from '@fly-novel/tools'
import type { Session } from '@fly-novel/session'

const installed = new WeakSet<object>()

/** 显式装配观察监听器；只处理所属工具服务身份发起的事件。 */
export const fsObservationPolicyPlugin = Object.assign(function fsObservationPolicyPlugin(ctx: Context): void {
  const tools = ctx.tools
  const sessions = ctx.sessions
  const identity = tools.agent
  if (!identity) throw new Error('观察策略需要 Agent 工具身份')
  if (installed.has(identity)) throw new Error('当前 Agent 已装配文件观察策略')
  installed.add(identity)
  let active = true
  let observations = new WeakMap<Session, Map<string, FsObservation>>()
  ctx.effect(() => () => { active = false; observations = new WeakMap(); installed.delete(identity) })

  function matches(actor: object | undefined): actor is ToolRunContext {
    return actor !== undefined && 'agent' in actor && actor.agent === identity
  }
  function owner(actor: ToolRunContext): Session | undefined {
    const session = actor.session
    if (session && (!session.active || sessions.get(session.id) !== session)) throw new Error('文件观察 Session 不属于当前 Agent 或已关闭')
    return session
  }
  function prior(target: FsTarget, actor: ToolRunContext): FsObservation | undefined {
    const session = owner(actor)
    return session ? observations.get(session)?.get(target.targetKey) : undefined
  }
  function required(target: FsTarget, actor: ToolRunContext, verb: 'edit' | 'delete'): { version: FsVersion } {
    const observation = prior(target, actor)
    if (!observation) throw new FsError(`${verb} requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    if (observation.kind === 'absent') throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    return { version: observation.version }
  }
  ctx.on('session/disposed', async session => { observations.delete(session) })
  ctx.on('fs/observed', (target, observation, actor) => {
    if (!active || !matches(actor)) return
    const session = owner(actor)
    if (!session) return
    let targets = observations.get(session)
    if (!targets) { targets = new Map(); observations.set(session, targets) }
    targets.set(target.targetKey, observation)
  })
  ctx.on('fs/write-intent', (target, actor, next) => {
    if (!active || !matches(actor)) return Promise.resolve(next())
    return Promise.resolve().then((): FsWriteIntent => {
      if (!active) throw new Error('文件观察策略已销毁')
      const observation = prior(target, actor)
      return observation?.kind === 'present' ? { kind: 'replaceIfVersion', version: observation.version } : { kind: 'createIfAbsent' }
    })
  })
  ctx.on('fs/edit-intent', (target, actor, next) => {
    if (!active || !matches(actor)) return Promise.resolve(next())
    return Promise.resolve().then(() => { if (!active) throw new Error('文件观察策略已销毁'); return required(target, actor, 'edit') })
  })
  ctx.on('fs/delete-intent', (target, actor, next) => {
    if (!active || !matches(actor)) return Promise.resolve(next())
    return Promise.resolve().then(() => { if (!active) throw new Error('文件观察策略已销毁'); return required(target, actor, 'delete') })
  })
}, { inject: ['tools', 'sessions'] })

/** Harness 插件注册定义；不会自动加入生产 Preset。 */
export const fsObservationPolicyPluginDefinition = {
  id: 'fs-observation-policy', version: '1.0.0', description: '按会话记录文件观察并提供修改保护', plugin: fsObservationPolicyPlugin,
}
