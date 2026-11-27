import { randomUUID } from 'node:crypto'
import { bootstrapAgents, type Agent, type AgentPluginDefinition } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'
import { characterResponseSchema, type CharacterKnowledgeGrant, type CharacterOutcome } from '../story-workflow/character-participation.js'
import { parseStrictJson } from '../story-workflow/types.js'
import type { StoryCharacterScope } from './story-character-participation.js'

export interface StoryCharacterConfig {
  readonly version: string
  readonly provider: string
  readonly model: string
  readonly adapter: LlmAdapter
  readonly timeoutMs: number
  /** 由可信代码装配的角色专用插件。不得注册读取其他资料或写入业务数据的能力。 */
  readonly plugins?: readonly { definition: AgentPluginDefinition; config?: unknown }[]
}

type Preparation = Awaited<ReturnType<StoryCharacterScope['prepare']>>
type Request = Preparation['request']
interface Slot { agent: Agent; version: string; entries: Set<string>; history: string[] }

/** 当前子故事持有的角色运行器。调用方须在退出时等待 close。 */
export async function openStoryCharacterRuntime(scope: StoryCharacterScope, configure: (characterId: string) => StoryCharacterConfig) {
  const framework = await bootstrapAgents()
  const base = framework.presets.get('character-agent')
  const slots = new Map<string, Slot>()
  const active = new Map<string, Promise<unknown>>()
  const cleanupFailures = new Map<string, unknown>()
  const registered = new Map<string, AgentPluginDefinition>()
  const lifecycle = new AbortController()
  let closing: Promise<void> | undefined

  async function disposeSlot(characterId: string) {
    const existing = slots.get(characterId)
    if (!existing) return
    try { await framework.manager.dispose(existing.agent.info.identity.id) }
    catch (error) { cleanupFailures.set(characterId, error); throw error }
    finally { slots.delete(characterId) }
  }

  async function createSlot(characterId: string, config: StoryCharacterConfig) {
    const presetId = `story-character-${randomUUID()}`
    const plugins = base.plugins.filter(item => item.pluginId !== 'mock-memory' && item.pluginId !== 'character-example-memory')
    for (const { definition, config: pluginConfig } of config.plugins ?? []) {
      const prior = registered.get(definition.id)
      if (prior && prior !== definition) throw new Error('角色插件定义冲突')
      if (!prior) {
        framework.plugins.register(definition)
        registered.set(definition.id, definition)
      }
      plugins.push({ pluginId: definition.id, config: pluginConfig })
    }
    framework.presets.register({ ...base, id: presetId, plugins })
    const agent = await framework.manager.create({ id: presetId, presetId, parameters: { characterId }, pluginConfigs: {
      'agent-loop-runtime': { provider: config.provider, model: config.model, maxSteps: 1 },
      llm: { adapters: [{ providers: [config.provider], adapter: config.adapter }] },
    } })
    const slot = { agent, version: config.version, entries: new Set<string>(), history: [] }
    slots.set(characterId, slot)
    return slot
  }

  async function run(preparation: Preparation, config: StoryCharacterConfig, signal?: AbortSignal) {
    const { request, entries } = preparation
    const { characterId } = request
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const requestSignal = AbortSignal.any(signal ? [lifecycle.signal, signal, timeout] : [lifecycle.signal, timeout])
    const allowed = new Set(entries.map(item => JSON.stringify(item)))
    let history: string[] = []
    let outcome: CharacterOutcome
    try {
      requestSignal.throwIfAborted()
      let slot = slots.get(characterId)
      if (slot && (slot.version !== config.version || [...slot.entries].some(item => !allowed.has(item)))) {
        await disposeSlot(characterId)
        slot = undefined
      }
      slot ??= await createSlot(characterId, config)
      history = [...slot.history]
      const cancel = () => slot.agent.cancel()
      requestSignal.addEventListener('abort', cancel, { once: true })
      let text: string
      try {
        requestSignal.throwIfAborted()
        const visible = entries.map(({ category, content }) => ({ category, content }))
        text = (await slot.agent.run({ prompt: `以本角色视角回应当前处境。observation 是所见所闻，known 是已有认知，rumor 未经证实，unknown 表示未知。行动只描述尝试，不判定结果。只返回 JSON。发言或动作使用 {"kind":"respond","speech":[{"text":"原话","channel":"normal 或 whisper","intendedCharacterIds":[]}],"actions":["行动尝试"]}；也可返回 {"kind":"wait"} 或 {"kind":"decline"}。可用 privateThought 单独表达内心。已获准信息：${JSON.stringify(visible)}` })).content
      } finally { requestSignal.removeEventListener('abort', cancel) }
      requestSignal.throwIfAborted()
      try {
        if (Buffer.byteLength(text) > 64 * 1024) throw new Error('角色响应超过大小限制')
        outcome = { status: 'responded', response: characterResponseSchema.parse(parseStrictJson(text)) }
        slot.entries = allowed
        slot.history.push(request.participationId)
      } catch { outcome = { status: 'invalid' } }
    } catch {
      if (cleanupFailures.has(characterId)) throw new Error('角色实例清理失败', { cause: cleanupFailures.get(characterId) })
      outcome = { status: signal?.aborted || lifecycle.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'failed' }
    }
    if (outcome.status !== 'responded') await disposeSlot(characterId)
    return { outcome, history, configVersion: config.version, preparation }
  }

  return Object.freeze({
    async respond(request: Request, grants: readonly CharacterKnowledgeGrant[], signal?: AbortSignal) {
      if (closing) throw new Error('角色运行器已关闭')
      if (cleanupFailures.has(request.characterId)) throw new Error('角色实例清理结果待核查', { cause: cleanupFailures.get(request.characterId) })
      if (active.has(request.characterId)) throw new Error('角色正在执行其他参与请求')
      const operation = (async () => {
        const preparation = await scope.prepare(request, grants)
        const config = configure(request.characterId)
        if (!config.provider.trim() || !config.model.trim() || !config.version.trim() || !Number.isSafeInteger(config.timeoutMs) ||
          config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) throw new Error('角色运行配置无效')
        return run(preparation, config, signal)
      })()
      active.set(request.characterId, operation)
      try { return await operation } finally { active.delete(request.characterId) }
    },
    close() {
      return closing ??= (async () => {
        lifecycle.abort()
        await Promise.allSettled(active.values())
        const errors = [...cleanupFailures.values()]
        try { await framework.manager.disposeAll() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, '角色运行器清理失败')
      })()
    },
  })
}
