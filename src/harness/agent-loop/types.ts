import type { LlmFailure, UserMessage } from '@fly-novel/llm'
import type {PromptAssembly} from '../system-prompt/index.ts'

import type {TurnEndReason } from '../session/index.ts'



export type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

export type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

export type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
  }