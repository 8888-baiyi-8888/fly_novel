/**
 * 原地递归冻结对象图，保留 AbortSignal 的可变状态。
 * @param value 待冻结的值。
 * @returns 冻结所有可枚举子对象后的原值。
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* 循环条件保证存在待处理项。 */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* 下标受已记录的属性数量限制。 */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}
