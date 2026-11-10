import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { isPathUnder } from '@fly-novel/fs-sandbox'

/** 稳定业务身份及其已有的专属目录，由可信应用提供。 */
export interface WorldWorkspaceAgent {
  readonly agentId: string
  readonly writableRoot: string
}

/** 单个世界的读取范围、受保护目录和 Agent 目录。 */
export interface WorldWorkspaceConfig {
  readonly worldId: string
  readonly readRoot: string
  readonly confirmedRoot: string
  readonly catalogRoot: string
  readonly mainAgent: WorldWorkspaceAgent
  readonly agents: readonly WorldWorkspaceAgent[]
}

function identity(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error(`${label}必须非空且无首尾空白`)
}

async function directory(path: string, label: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(`${label}必须是绝对目录路径`)
  const physical = await realpath(path)
  if (!(await stat(physical)).isDirectory()) throw new Error(`${label}必须是现有目录`)
  if (physical !== resolve(path)) throw new Error(`${label}必须使用真实路径`)
  return physical
}

async function overlaps(left: string, right: string): Promise<boolean> {
  return await isPathUnder(left, right) || await isPathUnder(right, left)
}

/**
 * 校验可信应用提供的完整世界配置集合，不创建或修改目录。
 * @param configs 必须包含本次应用装配范围内全部世界；Agent ID 在同一世界内唯一。
 * @returns 防止调用方修改的目录与身份快照，可供后续 Agent 装配使用。
 * @throws 目录不存在、不是规范真实路径、越界或配置冲突时拒绝。
 * @remarks 只检查传入集合；不锁定目录，也不防止本机并发替换路径或硬链接。
 */
export async function validateWorldWorkspaceConfigs(configs: readonly WorldWorkspaceConfig[]): Promise<readonly WorldWorkspaceConfig[]> {
  if (!Array.isArray(configs) || configs.length === 0) throw new Error('必须提供至少一个世界配置')
  const worlds: WorldWorkspaceConfig[] = []
  const worldIds = new Set<string>()
  for (const config of configs) {
    if (!config || typeof config !== 'object') throw new Error('世界配置无效')
    identity(config.worldId, '世界 ID')
    if (worldIds.has(config.worldId)) throw new Error('世界 ID 重复')
    worldIds.add(config.worldId)
    if (!config.mainAgent || !Array.isArray(config.agents)) throw new Error('必须提供主 Agent 和特殊 Agent 列表')
    const readRoot = await directory(config.readRoot, '世界读取根')
    const confirmedRoot = await directory(config.confirmedRoot, '已确认资料根')
    const catalogRoot = await directory(config.catalogRoot, '资料目录保护根')
    const ids = new Set<string>()
    const validateAgent = async (agent: WorldWorkspaceAgent): Promise<WorldWorkspaceAgent> => {
      if (!agent || typeof agent !== 'object') throw new Error('Agent 配置无效')
      identity(agent.agentId, 'Agent ID')
      if (ids.has(agent.agentId)) throw new Error('同一世界的 Agent ID 重复')
      ids.add(agent.agentId)
      return Object.freeze({ agentId: agent.agentId, writableRoot: await directory(agent.writableRoot, 'Agent 专属目录') })
    }
    const mainAgent = await validateAgent(config.mainAgent)
    const agents: WorldWorkspaceAgent[] = []
    for (const agent of config.agents) agents.push(await validateAgent(agent))
    const roots = [confirmedRoot, catalogRoot, mainAgent.writableRoot, ...agents.map(agent => agent.writableRoot)]
    for (const root of roots) {
      if (!await isPathUnder(root, readRoot)) throw new Error('受保护目录和 Agent 专属目录必须位于世界读取根内')
    }
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        if (await overlaps(roots[i]!, roots[j]!)) throw new Error('同一世界的受保护目录和 Agent 专属目录不能重叠')
      }
    }
    for (const world of worlds) {
      if (await overlaps(readRoot, world.readRoot)) throw new Error('不同世界的读取根不能重叠')
    }
    worlds.push(Object.freeze({ worldId: config.worldId, readRoot, confirmedRoot, catalogRoot, mainAgent, agents: Object.freeze(agents) }))
  }
  return Object.freeze(worlds)
}
