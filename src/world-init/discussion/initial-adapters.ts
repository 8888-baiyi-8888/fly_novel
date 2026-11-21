import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { formatMapDocument, parseMapPlace, type MapStore } from '@fly-novel/map'
import { formatCharacterDocument, parseCharacterDocument, type CharacterStore } from '@fly-novel/character'
import type { DiscussionTargetAdapter } from './service.js'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

/**
 * 为地图地点和人物提供当前读取及候选格式校验。
 * @param world 由可信应用校验的世界配置。
 * @param mapAgentId 地图负责人身份。
 * @param characterAgentId 人物负责人身份。
 * @param map 调用方持有的地图存储。
 * @param characters 调用方持有的人物存储。
 * @returns 不具有当前资料写权限的适配能力。
 * @throws 存储世界或负责人根不匹配时拒绝。
 */
export function createInitialDiscussionAdapter(world: WorldWorkspaceConfig, mapAgentId: string, characterAgentId: string, map: MapStore, characters: CharacterStore): DiscussionTargetAdapter {
  const mapOwner = world.agents.find(item => item.agentId === mapAgentId)
  const characterOwner = world.agents.find(item => item.agentId === characterAgentId)
  if (!mapOwner || !characterOwner || map.boundWorldId !== world.worldId || map.rootDirectory !== mapOwner.writableRoot || characters.rootDirectory !== characterOwner.writableRoot) throw new Error('地点或人物存储与讨论世界身份不匹配')
  return {
    async read(target) {
      if (target.kind === 'place') {
        const result = await map.readPlace(target.id)
        return { content: formatMapDocument(result.document), version: result.version }
      }
      const result = await characters.readVersioned(target.id)
      return { content: formatCharacterDocument(result.document), version: result.version }
    },
    async assertNoLegacyCandidate(target) {
      if (target.kind !== 'character') return
      for (const name of ['pending.md', 'pending.json', 'operation.json', 'backup.md', 'initialization-operation.json', 'initialization-backup.md']) {
        try { await lstat(join(characters.rootDirectory, target.id, name)) }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
          throw error
        }
        throw new Error('人物存在已有候选或未完成操作，需要先核查')
      }
    },
    async validate(target, content) {
      if (target.kind === 'place') {
        const document = parseMapPlace(content)
        if (document.id !== target.id || document.worldId !== world.worldId) throw new Error('地点候选身份不匹配')
        await map.validatePlaceCandidate(document)
      } else {
        const document = parseCharacterDocument(content)
        if (document.metadata.id !== target.id || document.metadata.contentStatus !== 'pending') throw new Error('人物候选身份或状态不匹配')
      }
    },
  }
}
