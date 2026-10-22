/** 按追加顺序保存当前模型上下文所引用的 Session 事件序号。 */
export class SessionSurface {
  private readonly eventSequences: number[] = []

  /** 将一条消息事件追加到当前上下文末尾。 */
  append(eventSequence: number): void {
    this.eventSequences.push(eventSequence)
  }

  /** 返回当前上下文引用的事件序号快照。 */
  read(): readonly number[] {
    return this.eventSequences.slice()
  }

  /** 清空上下文引用。 */
  clear(): void {
    this.eventSequences.length = 0
  }
}
