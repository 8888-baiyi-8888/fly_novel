import { createHash } from 'node:crypto'
import type { FileSystem } from '@fly-novel/fs'
import { sameWorldWorkspace, snapshotWorldWorkspace, type WorldWorkspaceConfig } from '../workspace/config.js'
import { resolveCatalogTarget } from '../workspace/catalog/path.js'
import type { DiscussionTargetAdapter } from './service.js'

/** 为可信应用已选成果增加文件读取与隔离候选；文件内容不作为目录确认。 */
export function withFileDiscussionAdapter(base: DiscussionTargetAdapter, world: WorldWorkspaceConfig, fs: FileSystem): DiscussionTargetAdapter {
  world = snapshotWorldWorkspace(world)
  if (base.worldBinding && !sameWorldWorkspace(base.worldBinding, world)) throw new Error('文件候选适配器世界绑定不匹配')
  const resolveSource = async (target: { ownerAgentId: string; path: string }) => {
    const source = await resolveCatalogTarget(world, target.ownerAgentId, target.path)
    if (source.path !== target.path) throw new Error('成果标识必须使用规范真实路径')
    return source
  }
  return {
    worldBinding: snapshotWorldWorkspace(world),
    isTargetBoundToWorld(target, expected) { return sameWorldWorkspace(world, expected) && (target.kind === 'file' || base.isTargetBoundToWorld?.(target, expected) === true) },
    async validateStored(target, content) {
      if (target.kind !== 'file') return base.validateStored(target, content)
      if (content.includes('\0')) throw new Error('候选正文不能包含空字符')
    },
    async read(target) {
      if (target.kind !== 'file') return base.read(target)
      const source = await resolveSource(target)
      const file = await fs.resolve(source.absolutePath); const before = await fs.stat(file)
      if (!before || before.type !== 'file') throw new Error('成果文件不存在')
      const bytes = await fs.readBytes(file, undefined, 1024 * 1024)
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const after = await fs.stat(file); const resolved = await resolveSource(target)
      if (!after || before.version !== after.version || resolved.absolutePath !== source.absolutePath) throw new Error('成果读取期间变化')
      return { content, version: createHash('sha256').update(bytes).digest('hex') }
    },
    async assertNoLegacyCandidate(target) {
      if (target.kind !== 'file') return base.assertNoLegacyCandidate(target)
      await resolveSource(target)
    },
    async validate(target, content) {
      if (target.kind !== 'file') return base.validate(target, content)
      await resolveSource(target)
      if (content.includes('\0')) throw new Error('候选正文不能包含空字符')
    },
  }
}
