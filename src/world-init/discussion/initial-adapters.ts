import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { formatMapDocument, parseMapPlace, type MapStore } from '@fly-novel/map'
import { formatCharacterDocument, parseCharacterDocument, formatCharacterRelationship, parseCharacterRelationship, type CharacterStore, type CharacterRelationshipStore } from '@fly-novel/character'
import type { DiscussionTargetAdapter } from './service.js'
import { sameWorldWorkspace, snapshotWorldWorkspace, type WorldWorkspaceConfig } from '../workspace/config.js'
import { formatOrganizationDocument, parseOrganization, parseOrganizationRelation, parseOrganizationMembership, type OrganizationStore } from '@fly-novel/organization'
import { formatHistoryEvent, parseHistoryEvent, type HistoryStore } from '@fly-novel/history'

/**
 * 为地图地点和人物提供当前读取及候选格式校验。
 * @param world 由可信应用校验的世界配置。
 * @param options 所需模块的可信负责人及存储；人物关系根须位于人物负责人目录的 relationships 子目录。
 * @returns 不具有当前资料写权限的适配能力。
 * @throws 存储世界或负责人根不匹配时拒绝。
 */
export function createInitialDiscussionAdapter(world: WorldWorkspaceConfig, options: {
  map?: { agentId: string; store: MapStore }; characters?: { agentId: string; store: CharacterStore }
  organization?: { agentId: string; store: OrganizationStore }; history?: { agentId: string; store: HistoryStore }; relationships?: CharacterRelationshipStore
}): DiscussionTargetAdapter {
  world = snapshotWorldWorkspace(world)
  options = { ...options, ...(options.map ? { map: { ...options.map } } : {}), ...(options.characters ? { characters: { ...options.characters } } : {}),
    ...(options.organization ? { organization: { ...options.organization } } : {}), ...(options.history ? { history: { ...options.history } } : {}) }
  const { organization, history, relationships } = options
  const mapOwner = world.agents.find(item => item.agentId === options.map?.agentId)
  const characterOwner = world.agents.find(item => item.agentId === options.characters?.agentId)
  if (options.map && (!mapOwner || options.map.store.boundWorldId !== world.worldId || options.map.store.rootDirectory !== mapOwner.writableRoot)) throw new Error('地图存储与讨论世界身份不匹配')
  if (options.characters && (!characterOwner || options.characters.store.rootDirectory !== characterOwner.writableRoot)) throw new Error('人物存储与讨论世界身份不匹配')
  if (organization && (organization.store.worldId !== world.worldId || !world.agents.some(item => item.agentId === organization.agentId && item.writableRoot === organization.store.rootDirectory))) throw new Error('组织存储与讨论世界身份不匹配')
  if (history && (history.store.worldId !== world.worldId || !world.agents.some(item => item.agentId === history.agentId && item.writableRoot === history.store.rootDirectory))) throw new Error('历史存储与讨论世界身份不匹配')
  if (relationships && (!characterOwner || relationships.worldId !== world.worldId || relationships.rootDirectory !== join(characterOwner.writableRoot, 'relationships'))) throw new Error('人物关系存储与讨论世界身份不匹配')
  const map = () => { if (!options.map) throw new Error('尚未装配地图候选能力'); return options.map.store }
  const characters = () => { if (!options.characters) throw new Error('尚未装配人物候选能力'); return options.characters.store }
  return {
    worldBinding: snapshotWorldWorkspace(world),
    isTargetBoundToWorld(target, expected) {
      if (!sameWorldWorkspace(world, expected)) return false
      if (target.kind === 'place') return options.map !== undefined
      if (target.kind === 'character') return options.characters !== undefined
      if (target.kind === 'character-relationship') return relationships !== undefined
      if (target.kind === 'history-event') return history !== undefined
      if (target.kind === 'organization' || target.kind === 'organization-relation' || target.kind === 'organization-membership') return organization !== undefined
      return false
    },
    async validateStored(target, content) {
      if (target.kind === 'place') { const doc = parseMapPlace(content); if (doc.id !== target.id || doc.worldId !== world.worldId) throw new Error('地点候选身份不匹配'); return }
      if (target.kind === 'character') { const doc = parseCharacterDocument(content); if (doc.metadata.id !== target.id || doc.metadata.contentStatus !== 'pending') throw new Error('人物候选身份或状态不匹配'); return }
      if (target.kind === 'character-relationship') { const doc = parseCharacterRelationship(content); if (doc.id !== target.id || doc.worldId !== world.worldId || doc.contentStatus !== 'suggested') throw new Error('人物关系候选身份不匹配'); return }
      if (target.kind === 'history-event') { const doc = parseHistoryEvent(content); if (doc.id !== target.id || doc.worldId !== world.worldId || doc.contentStatus !== 'suggested') throw new Error('历史候选身份不匹配'); return }
      if (target.kind === 'organization' || target.kind === 'organization-relation' || target.kind === 'organization-membership') {
        const doc = target.kind === 'organization' ? parseOrganization(content) : target.kind === 'organization-relation' ? parseOrganizationRelation(content) : parseOrganizationMembership(content)
        if (doc.id !== target.id || doc.worldId !== world.worldId) throw new Error('组织候选身份不匹配')
        return
      }
      throw new Error('尚未装配该目标的候选能力')
    },
    async read(target) {
      if (target.kind === 'character-relationship') {
        if (!relationships) throw new Error('尚未装配人物关系候选能力')
        const result = await relationships.read(target.id)
        return { content: formatCharacterRelationship(result.document), version: result.version }
      }
      if (target.kind === 'file') throw new Error('尚未装配文件候选能力')
      if (target.kind === 'situation' || target.kind === 'situation-start' || target.kind === 'development' || target.kind === 'specific') throw new Error('尚未装配该目标的候选能力')
      if (target.kind === 'history-event') {
        if (!history) throw new Error('尚未装配历史候选能力')
        const result = await history.store.readEvent(target.id)
        return { content: formatHistoryEvent(result.document), version: result.version }
      }
      if (target.kind === 'place') {
        const result = await map().readPlace(target.id)
        return { content: formatMapDocument(result.document), version: result.version }
      }
      if (target.kind === 'organization-membership' || target.kind === 'organization' || target.kind === 'organization-relation') {
        if (!organization) throw new Error('尚未装配组织候选能力')
        const result = target.kind === 'organization' ? await organization.store.readOrganization(target.id)
          : target.kind === 'organization-relation' ? await organization.store.readRelation(target.id) : await organization.store.readMembership(target.id)
        return { content: formatOrganizationDocument(result.document), version: result.version }
      }
      const result = await characters().readVersioned(target.id)
      return { content: formatCharacterDocument(result.document), version: result.version }
    },
    async assertNoLegacyCandidate(target) {
      if (target.kind === 'history-event') {
        if (!history) throw new Error('尚未装配历史候选能力')
        try { await lstat(join(history.store.rootDirectory, 'candidates', `${target.id}.json`)) }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error }
        throw new Error('历史事件存在已有候选，需要先核查')
      }
      if (target.kind !== 'character') return
      for (const name of ['pending.md', 'pending.json', 'operation.json', 'backup.md', 'initialization-operation.json', 'initialization-backup.md']) {
        try { await lstat(join(characters().rootDirectory, target.id, name)) }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
          throw error
        }
        throw new Error('人物存在已有候选或未完成操作，需要先核查')
      }
    },
    async validate(target, content) {
      if (target.kind === 'character-relationship') {
        if (!relationships) throw new Error('尚未装配人物关系候选能力')
        const document = parseCharacterRelationship(content)
        if (document.id !== target.id || document.worldId !== world.worldId) throw new Error('人物关系候选身份不匹配')
        return relationships.validateCandidate(document)
      }
      if (target.kind === 'file') throw new Error('尚未装配文件候选能力')
      if (target.kind === 'situation' || target.kind === 'situation-start' || target.kind === 'development' || target.kind === 'specific') throw new Error('尚未装配该目标的候选能力')
      if (target.kind === 'history-event') {
        if (!history) throw new Error('尚未装配历史候选能力')
        const document = parseHistoryEvent(content)
        if (document.id !== target.id || document.worldId !== world.worldId) throw new Error('历史候选身份不匹配')
        await history.store.validateEventCandidate(document)
      } else if (target.kind === 'place') {
        const document = parseMapPlace(content)
        if (document.id !== target.id || document.worldId !== world.worldId) throw new Error('地点候选身份不匹配')
        await map().validatePlaceCandidate(document)
      } else if (target.kind === 'character') {
        const document = parseCharacterDocument(content)
        if (document.metadata.id !== target.id || document.metadata.contentStatus !== 'pending') throw new Error('人物候选身份或状态不匹配')
      } else {
        if (!organization) throw new Error('尚未装配组织候选能力')
        const document = target.kind === 'organization' ? parseOrganization(content)
          : target.kind === 'organization-relation' ? parseOrganizationRelation(content) : parseOrganizationMembership(content)
        if (document.id !== target.id || document.worldId !== world.worldId) throw new Error('成员关系候选身份不匹配')
        if ('person' in document) await organization.store.validateMembershipCandidate(document)
        else if ('fromId' in document) await organization.store.validateRelationCandidate(document)
        else await organization.store.validateOrganizationCandidate(document)
      }
    },
  }
}
