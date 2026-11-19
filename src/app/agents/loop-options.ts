/** 可信装配在打开存储或创建 Session 前校验可选的单轮步数限制。 */
export function validateAgentMaxSteps(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('maxSteps 必须是正整数')
}
