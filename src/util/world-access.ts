import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type Lease = { gate: WorldAccess; active: boolean; children: Set<Promise<unknown>> }
const context = new AsyncLocalStorage<Lease>()
const gates = new Set<WorldAccess>()
const unbound = new Map<string, number>()

function normalize(path: string): string {
  if (!isAbsolute(path)) throw new Error('协调路径必须为绝对路径')
  const result = resolve(path)
  return process.platform === 'win32' ? result.toLowerCase() : result
}
function contains(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a) }

/** 进程内世界访问协调；调用方负责真实路径与单可信写入进程。 */
export class WorldAccess {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private closing = false
  private constructor(readonly roots: readonly string[]) {}

  /** 判断目录是否处于该协调范围内。 */
  covers(path: string): boolean { const value = normalize(path); return this.roots.some(root => contains(root, value)) }

  /** 注册世界资料及候选等根；存在活动操作或重叠注册时拒绝。 */
  static register(paths: readonly string[]): WorldAccess {
    const roots = paths.map(normalize)
    if (!roots.length || new Set(roots).size !== roots.length) throw new Error('协调根不能为空或重复')
    for (const root of roots) {
      if ([...gates].some(gate => gate.roots.some(other => overlaps(root, other)))) throw new Error('协调根与已有世界重叠')
      if ([...unbound.keys()].some(path => overlaps(root, path))) throw new Error('协调范围存在未完成操作')
    }
    const gate = new WorldAccess(Object.freeze(roots)); gates.add(gate); return gate
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('世界协调器正在关闭'))
    this.pending++
    const result = this.tail.then(async () => {
      const lease: Lease = { gate: this, active: true, children: new Set() }
      try { return await context.run(lease, task) } finally {
        while (lease.children.size) await Promise.allSettled([...lease.children])
        lease.active = false
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result.finally(() => { this.pending-- })
  }

  /** 在世界操作边界内执行检查及发布；仅覆盖接入本协调器的入口。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    const current = context.getStore()
    if (current?.active) {
      if (current.gate !== this) return Promise.reject(new Error('不能嵌套不同世界的协调操作'))
      const result = Promise.resolve().then(task)
      current.children.add(result)
      void result.then(() => current.children.delete(result), () => current.children.delete(result))
      return result
    }
    return this.schedule(task)
  }

  /** 停止新操作，等待已受理任务并释放注册。 */
  async close(): Promise<void> {
    if (context.getStore()?.gate === this && context.getStore()?.active) throw new Error('不能在世界操作中关闭协调器')
    this.closing = true
    await this.tail
    if (this.pending !== 0) await Promise.resolve()
    gates.delete(this)
  }
}

/** 在进入模块队列前登记访问；未注册范围仍跟踪活动操作以防中途注册。 */
export function withWorldAccess<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
  const normalized = paths.map(normalize)
  const matching = [...gates].filter(gate => gate.roots.some(root => normalized.some(path => contains(root, path))))
  if (matching.length > 1) return Promise.reject(new Error('操作跨越多个世界'))
  if (matching[0]) return matching[0].run(task)
  for (const path of normalized) unbound.set(path, (unbound.get(path) ?? 0) + 1)
  return Promise.resolve().then(task).finally(() => {
    for (const path of normalized) {
      const count = unbound.get(path)!
      if (count === 1) unbound.delete(path); else unbound.set(path, count - 1)
    }
  })
}

/** 跟踪等待协调器和模块队列的全部已受理操作。 */
export class CoordinatedOperations {
  private readonly pending = new Set<Promise<unknown>>()
  run<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
    const result = withWorldAccess(paths, task)
    this.pending.add(result)
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result))
    return result
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }
}
