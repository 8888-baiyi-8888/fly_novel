import { ToolCallId } from "./brand"
import { StreamChunk } from "./types"

/** Lossless compact records embedded in durable Assistant attempt events. */
export type AssistantStreamRecord =
  | {
    readonly type: 'text-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'reasoning-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'tool-call-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly id: ToolCallId
    readonly name?: string
    readonly args: readonly string[]
  }
  | { readonly type: 'chunk'; readonly time: number; readonly chunk: StreamChunk }