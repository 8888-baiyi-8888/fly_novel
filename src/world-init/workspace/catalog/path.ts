import { realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { validateCatalogRelativePath } from './format.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../config.js'

/** 解析后的世界相对路径及可信文件真实路径；不代表文件内容已读取。 */
export interface CatalogTarget { readonly path: string; readonly absolutePath: string }

/**
 * 检查成果属于指定世界的指定 Agent，并返回目标的规范路径。
 * @param config 由可信应用提供的完整世界配置。
 * @param agentId 由可信装配固定的业务身份，不能取自模型输入。
 * @param path 相对于世界读取根的规范路径。
 * @returns 现有普通文件的规范路径；链接指向的实际文件也必须属于本人目录。
 * @throws 配置无效、身份不存在、目标不存在、不是普通文件或越权时拒绝。
 * @remarks 不防止检查后路径被外部进程替换或硬链接访问。
 */
export async function resolveCatalogTarget(config: WorldWorkspaceConfig, agentId: string, path: string): Promise<CatalogTarget> {
  const [world] = await validateWorldWorkspaceConfigs([config])
  if (!world) throw new Error('世界配置无效')
  const owner = [world.mainAgent, ...world.agents].find(agent => agent.agentId === agentId)
  if (!owner) throw new Error('资料负责人不属于该世界')
  const valid = validateCatalogRelativePath(path)
  const requested = resolve(world.readRoot, ...valid.split('/'))
  if (!await isPathUnder(requested, owner.writableRoot)) throw new Error('成果路径不属于该 Agent')
  const actual = await realpath(requested)
  if (!await isPathUnder(actual, owner.writableRoot) || !await isPathUnder(actual, world.readRoot) ||
      await isPathUnder(actual, world.confirmedRoot) || await isPathUnder(actual, world.catalogRoot)) {
    throw new Error('成果真实路径超出 Agent 授权范围')
  }
  if (!(await stat(actual)).isFile()) throw new Error('成果必须是普通文件')
  const canonical = relative(world.readRoot, actual).split(sep).join('/')
  return Object.freeze({ path: validateCatalogRelativePath(canonical), absolutePath: actual })
}
