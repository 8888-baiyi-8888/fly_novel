import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceWritableRoots } from '@fly-novel/sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@fly-novel/sandbox'

/** 可信装配提供的文件修改策略；不从模型输入或工作目录推导权限。 */
export interface SandboxPolicyConfig {
  mode?: SandboxMode
  workspaceRoot?: string
  additionalWritableRoots?: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context { sandboxPolicy: SandboxPolicyService }
}

/** 一个 Agent 作用域内不可变的文件修改策略。 */
export class SandboxPolicyService {
  private readonly policy: Readonly<SandboxExecutionPolicy>

  constructor(config: SandboxPolicyConfig = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('沙箱策略配置必须是对象')
    const mode = config.mode ?? 'read-only'
    if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') throw new Error('沙箱策略模式无效')
    if (mode === 'workspace-write' && config.workspaceRoot === undefined) throw new Error('workspace-write 必须显式配置工作区根目录')
    const root = config.workspaceRoot ?? process.cwd()
    validateAbsolute(root, '工作区根目录')
    if (config.additionalWritableRoots !== undefined && !Array.isArray(config.additionalWritableRoots)) throw new Error('附加可写根必须是数组')
    const additional = [...(config.additionalWritableRoots ?? [])]
    for (const path of additional) validateAbsolute(path, '附加可写根')
    if (mode === 'workspace-write') {
      const physical = realpathSync.native(root)
      if (!statSync(physical).isDirectory()) throw new Error('工作区根目录必须是现有目录')
      if (physical !== resolve(root)) throw new Error('工作区根目录必须使用真实路径')
    }
    const unique = Object.freeze([...new Set(additional)])
    const policy: SandboxExecutionPolicy = { mode, workspaceRoot: root, ...(unique.length ? { additionalWritableRoots: unique } : {}) }
    if (mode === 'workspace-write') workspaceWritableRoots(policy)
    this.policy = Object.freeze(policy)
  }

  /** 返回策略快照；无 Session 覆盖或调用级提权。 */
  resolve(): Readonly<SandboxExecutionPolicy> { return this.policy }
}

function validateAbsolute(path: unknown, label: string): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(`${label}必须是无 NUL 的绝对路径`)
}

/** 按 Agent 显式装配策略服务；默认模式只读。 */
export const sandboxPolicyPlugin = Object.assign(function sandboxPolicyPlugin(ctx: Context, config: SandboxPolicyConfig = {}): void {
  ctx.provide('sandboxPolicy', new SandboxPolicyService(config))
}, { provide: 'sandboxPolicy' })

export const sandboxPolicyPluginDefinition = {
  id: 'sandbox-policy', version: '1.0.0', description: '为 Agent 提供受信任的文件修改策略', plugin: sandboxPolicyPlugin,
}
