import type { SessionEvent } from '../types/index.ts'

/** 判断载荷字段是否为 JSON 对象，而非数组或标量。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 拒绝不规范的请求头字段和相互矛盾的工具失败元数据。
 * 此处不校验完整事件载荷或内嵌的供应商响应流。
 * @param event - 要检查其载荷字段之间关系的事件。
 * @param subject - 校验错误中显示的事件位置。
 * @throws 请求数据或请求头不是对象、可选头字段为空，或工具失败元数据与消息矛盾时抛错。
 */
export function validateSessionEventData(
  event: Pick<SessionEvent, 'type' | 'data'>,
  subject: string,
): void {
  const data: unknown = event.data
  if (event.type === 'request/header') {
    if (!isRecord(data)) throw new Error(`${subject} 的 data 必须是对象`)
    const header = data['header']
    if (!isRecord(header)) throw new Error(`${subject} 的 header 必须是对象`)
    if (Object.hasOwn(header, 'system')) throw new Error(`${subject} 必须省略 header.system，改用 system/message`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0) {
      throw new Error(`${subject} 必须省略空 tools`)
    }
    const defaults = header['adapterDefaults']
    if (isRecord(defaults) && Object.keys(defaults).length === 0) {
      throw new Error(`${subject} 必须省略空 adapterDefaults`)
    }
  } else if (event.type === 'tool/result') {
    if (!isRecord(data)) throw new Error(`${subject} 的 data 必须是对象`)
    if (data['error'] === undefined) return
    const message = data['message']
    const content = isRecord(message) ? message['content'] : undefined
    const block: unknown = Array.isArray(content) ? content[0] : undefined
    if (!isRecord(block) || block['isError'] !== true) {
      throw new Error(`${subject} 包含 error 时，消息必须满足 content[0].isError === true`)
    }
  }
}
