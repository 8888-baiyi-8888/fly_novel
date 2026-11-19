/** 受可信世界装配持有的资源；借用方不持有关闭权。 */
export interface OwnedResource<T> { value: T; close(): Promise<void> }

/** 合并并发打开并在所有者关闭时释放资源。 */
export class SharedResource<T> {
  private opening?: Promise<OwnedResource<T>>
  private closing?: Promise<void>
  private closed = false

  constructor(private readonly openResource: () => Promise<OwnedResource<T>>) {}

  async get(): Promise<T> {
    if (this.closed) throw new Error('共享存储已关闭')
    if (!this.opening) {
      const opening = this.openResource()
      this.opening = opening
      void opening.catch(error => { if (!(error instanceof AggregateError) && this.opening === opening) this.opening = undefined })
    }
    return (await this.opening).value
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = (async () => {
        if (!this.opening) return
        let resource: OwnedResource<T>
        try { resource = await this.opening } catch (error) { if (error instanceof AggregateError) throw error; return }
        await resource.close()
      })()
    }
    return this.closing
  }
}
