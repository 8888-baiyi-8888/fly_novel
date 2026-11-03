/**
 * 按列表顺序调用注册函数。发生错误时立即抛出，先前成功的注册由调用方负责。
 * @param items 要注册的对象。
 * @param register 负责单项注册的函数。
 */
export function registerAll<T>(items: readonly T[], register: (item: T) => void): void {
  for (const item of items) register(item)
}
