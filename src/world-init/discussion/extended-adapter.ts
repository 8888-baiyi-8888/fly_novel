import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJson, startSchema, overviewSchema, situationSchema, type SituationStore } from '@fly-novel/initial-situation'
import { parseDocumentJson, documentSchema, type DevelopmentStore } from '@fly-novel/world-development'
import { parseSpecificJson, specificDocumentSchema, type SpecificStore } from '@fly-novel/world-specific'
import type { WorldWorkspaceConfig } from '../workspace/config.js'
import type { DiscussionTargetAdapter } from './service.js'

type Owned<T> = { agentId: string; store: T }

/** 为可信世界装配局势、规划和专有内容的候选读取与校验。 */
export function withExtendedDiscussionAdapter(base: DiscussionTargetAdapter, world: WorldWorkspaceConfig, options: {
  situation?: Owned<SituationStore>; development?: Owned<DevelopmentStore>; specific?: Owned<SpecificStore>
}): DiscussionTargetAdapter {
  for (const item of [options.situation, options.development, options.specific]) {
    if (item && (item.store.worldId !== world.worldId || !world.agents.some(agent => agent.agentId === item.agentId && agent.writableRoot === item.store.rootDirectory))) throw new Error('候选存储与世界负责人不匹配')
  }
  const situation = () => { if (!options.situation) throw new Error('尚未装配局势候选能力'); return options.situation.store }
  const development = () => { if (!options.development) throw new Error('尚未装配规划候选能力'); return options.development.store }
  const specific = () => { if (!options.specific) throw new Error('尚未装配专有内容候选能力'); return options.specific.store }
  const content = (document: unknown) => `${JSON.stringify(document, null, 2)}\n`
  return {
    async validateStored(target, text) {
      if (target.kind === 'situation-start') { if (parseJson(text, startSchema).worldId !== world.worldId) throw new Error('世界起点候选身份不匹配'); return }
      if (target.kind === 'situation') { const doc = target.documentKind === 'overview' ? parseJson(text, overviewSchema) : parseJson(text, situationSchema); if (doc.id !== target.id || doc.worldId !== world.worldId || doc.contentStatus !== 'suggested') throw new Error('局势候选身份不匹配'); return }
      if (target.kind === 'development') { const doc = parseDocumentJson(text, documentSchema); if (doc.id !== target.id || doc.worldId !== world.worldId || doc.kind !== target.documentKind || doc.contentStatus !== 'suggested') throw new Error('规划候选身份不匹配'); return }
      if (target.kind === 'specific') { const doc = parseSpecificJson(text, specificDocumentSchema); if (doc.id !== target.id || doc.worldId !== world.worldId || doc.kind !== target.documentKind || doc.contentStatus !== 'suggested') throw new Error('专有内容候选身份不匹配'); return }
      return base.validateStored(target, text)
    },
    async read(target) {
      if (target.kind === 'situation-start') { const result = await situation().readStart(); return { content: content(result.document), version: result.version } }
      if (target.kind === 'situation') { const result = target.documentKind === 'overview' ? await situation().readOverview(target.id) : await situation().readSituation(target.id); return { content: content(result.document), version: result.version } }
      if (target.kind === 'development') { const result = await development().readDocument(target.documentKind, target.id); return { content: content(result.document), version: result.version } }
      if (target.kind === 'specific') { const result = await specific().readDocument(target.documentKind, target.id); return { content: content(result.document), version: result.version } }
      return base.read(target)
    },
    async assertNoLegacyCandidate(target) {
      if (target.kind === 'situation-start') return
      const root = target.kind === 'situation' ? situation().rootDirectory : target.kind === 'development' ? development().rootDirectory : target.kind === 'specific' ? specific().rootDirectory : undefined
      if (!root) return base.assertNoLegacyCandidate(target)
      if (target.kind !== 'situation' && target.kind !== 'development' && target.kind !== 'specific') throw new Error('候选类型无效')
      try { await lstat(join(root, 'candidates', `${target.id}.json`)) }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error }
      throw new Error('资料存在已有候选，需要先核查')
    },
    async validate(target, text) {
      if (target.kind === 'situation-start') {
        const doc = parseJson(text, startSchema)
        if (doc.worldId !== world.worldId) throw new Error('世界起点候选身份不匹配')
        await situation().readStart(); return
      }
      if (target.kind === 'situation') {
        const doc = target.documentKind === 'overview' ? parseJson(text, overviewSchema) : parseJson(text, situationSchema)
        if (doc.id !== target.id || doc.worldId !== world.worldId) throw new Error('局势候选身份不匹配')
        return situation().validateCandidate(target.documentKind, doc)
      }
      if (target.kind === 'development') {
        const doc = parseDocumentJson(text, documentSchema)
        if (doc.id !== target.id || doc.worldId !== world.worldId || doc.kind !== target.documentKind) throw new Error('规划候选身份不匹配')
        return development().validateCandidate(doc)
      }
      if (target.kind === 'specific') {
        const doc = parseSpecificJson(text, specificDocumentSchema)
        if (doc.id !== target.id || doc.worldId !== world.worldId || doc.kind !== target.documentKind) throw new Error('专有内容候选身份不匹配')
        return specific().validateCandidate(doc)
      }
      return base.validate(target, text)
    },
  }
}
