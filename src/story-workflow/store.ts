import { link, lstat, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { sceneEventIdentity, sceneEventSchema, type SceneEvent } from './scene-event.js'
import { evaluateWorldObjectives, eventAssessmentEvidence, worldObjectivesSchema } from './world-progress.js'
import { interactionObservationContent, interactionObservationSource, resolveInteractionPerceptions, sceneActionRecordSchema, sceneInteractionDecisionSchema, sceneInteractionDigest, sceneInteractionDispatchSchema, sceneInteractionEventSchema, verifySceneActions, visibleCharacterResponse, type SceneActionRecord, type SceneInteractionDecision, type SceneInteractionDispatch, type SceneInteractionEvent } from './scene-interaction.js'
import { characterClaimDigest, characterParticipationClaimSchema, characterParticipationResultSchema, projectCharacterParticipation, type CharacterParticipationClaim, type CharacterParticipationResult } from './character-participation.js'
import { isDeepStrictEqual } from 'node:util'
import { mapProposalKeySchema, mapProposalRecordSchema, mapRecordDigest, mapSceneCheckSchema, type MapProposalRecord, type MapSceneCheck, type SceneMapEvidence } from './map-scene.js'
import { storyNoticeSchema, storyProgressSchema, type StoryNotice, type StoryProgress } from './types.js'
import { sceneOrderSchema, sceneResultRecordSchema, sceneSetupRecordSchema, type SceneResultInput, type SceneResultRecord, type SceneSetupRecord } from './types.js'
import { collaborationSchema, parseStrictJson, planRecordSchema, simulationRecordSchema, siblingRunSchema, siblingDecisionSchema, storyNodeSchema, storyStepSchema, storyChoiceSchema, type Collaboration, type PlanRecord, type SimulationRecord, type SiblingDecision, type StoryNode, type StoryStep, type StoryChoice } from './types.js'

const uuid = z.string().uuid()
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
function within(parent: string, child: string): boolean {
  const rel = relative(key(parent), key(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 独立规划记录：仅创建与读取，调用方保证列出所有需要隔离的业务根。 */
export class PlanStore {
  private constructor(private readonly root: string) {}

  /** 打开现有真实目录；禁止与调用方提供的受保护目录重叠。 */
  static async open(root: string, protectedRoots: readonly string[]): Promise<PlanStore> {
    async function directory(path: string): Promise<string> {
      if (!isAbsolute(path)) throw new Error('目录必须是绝对路径')
      const resolved = await realpath(path)
      if (key(resolved) !== key(resolve(path)) || !(await lstat(resolved)).isDirectory()) throw new Error('目录必须是现有真实目录')
      return resolved
    }
    const realRoot = await directory(root)
    for (const path of protectedRoots) {
      const protectedRoot = await directory(path)
      if (within(realRoot, protectedRoot) || within(protectedRoot, realRoot)) throw new Error('规划目录与受保护目录重叠')
    }
    return new PlanStore(realRoot)
  }

  private path(id: string): string { return join(this.root, `${uuid.parse(id)}.json`) }

  /** 独占创建记录；失败保留原文件，错误包含运行 ID 以便核查。 */
  async save(record: PlanRecord): Promise<void> {
    const value = planRecordSchema.parse(record)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('规划记录超过大小限制')
    try { await writeFile(this.path(value.id), content, { encoding: 'utf8', flag: 'wx' }) }
    catch (error) { throw new Error(`规划保存失败或结果不明，请核查运行 ${value.id}`, { cause: error }) }
  }

  /** 读取并校验规划身份、版本及 JSON；损坏文件不会被修改。 */
  async read(id: string): Promise<PlanRecord> {
    const path = this.path(id)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(path)) !== key(path)) throw new Error('规划记录必须是普通文件')
    if (info.size > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const value = planRecordSchema.parse(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (value.id !== id) throw new Error('规划运行身份不匹配')
    return value
  }
}

const claimSchema = z.object({ formatVersion: z.literal(1), planId: uuid, childStoryId: uuid, collaborationId: uuid }).strict()

/** 使用独立目录保存单个事件的独占尝试及最终协作记录。 */
export class CollaborationStore {
  private constructor(private readonly root: string) {}

  private async deriveSceneEvent(worldId: string, runId: string, storyId: string, sceneId: string): Promise<SceneEvent> {
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    const result = await this.readSceneResult(setup)
    if (result?.formatVersion !== 2 || result.status === 'unresolved') throw new Error('场景缺少已结算的互动证据')
    const events = await this.listInteractionEvents(runId, storyId, sceneId)
    const sequence = await Promise.all(events.map(async event => {
      const actions = await this.readInteractionActions(event)
      return { order: event.sequence, participationId: event.participationId, characterId: event.characterId,
        sourceDigest: sceneInteractionDigest(event), speech: event.speech,
        actions: actions?.outcomes.map((outcome, index) => ({ ...outcome, attempt: event.actions[index]!,
          ruleAllowed: actions.rules[index]!.allowed, ruleBasis: actions.rules[index]!.basis })) ?? [] }
    }))
    return sceneEventSchema.parse({ formatVersion: 1, eventId: sceneEventIdentity(worldId, sceneId, result.interaction.digest), worldId,
      runId, storyId, sceneId, resultDigest: sceneInteractionDigest(result), interactionDigest: result.interaction.digest, status: result.status, sequence })
  }

  async recordSceneEvent(worldId: string, runId: string, storyId: string, sceneId: string): Promise<SceneEvent> {
    const event = await this.deriveSceneEvent(worldId, runId, storyId, sceneId)
    const content = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景事件超过大小限制')
    try { await writeFile(join(this.root, `${sceneId}.adopted-event.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return this.readSceneEvent(worldId, runId, storyId, sceneId)
      throw error
    }
    return event
  }

  async readSceneEvent(worldId: string, runId: string, storyId: string, sceneId: string): Promise<SceneEvent> {
    const expected = await this.deriveSceneEvent(worldId, runId, storyId, sceneId)
    const saved = sceneEventSchema.parse(await this.readFile(join(this.root, `${sceneId}.adopted-event.json`)))
    if (!isDeepStrictEqual(saved, expected)) throw new Error('已采用事件与场景证据不匹配')
    return saved
  }

  private participationPath(sceneId: string, participationId: string, suffix: 'claim' | 'result') {
    return join(this.root, `${sceneId}.${uuid.parse(participationId)}.character-${suffix}.json`)
  }

  async claimCharacterParticipation(claim: CharacterParticipationClaim) {
    const checked = characterParticipationClaimSchema.parse(claim)
    const { runId, storyId, sceneId, participationId } = checked.request
    const scene = await this.readSceneSetup(runId, storyId, sceneId)
    if (await this.readSceneResult(scene)) throw new Error('场景已有结果，不能启动角色')
    await this.assertSceneSetupOpen(runId, storyId)
    const text = `${JSON.stringify(checked)}\n`
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('角色参与请求超过大小限制')
    try { await writeFile(this.participationPath(sceneId, participationId, 'claim'), text, { flag: 'wx', encoding: 'utf8' }); return true }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    }
  }

  async saveCharacterParticipation(claim: CharacterParticipationClaim, input: Omit<CharacterParticipationResult, 'formatVersion' | 'participationId' | 'claimDigest'>) {
    const { runId, storyId, sceneId, participationId, characterId } = claim.request
    const existing = await this.readCharacterParticipation(runId, storyId, sceneId, participationId)
    if (existing.claim.request.characterId !== characterId || characterClaimDigest(existing.claim) !== characterClaimDigest(claim)) throw new Error('角色参与占用不匹配')
    const result = characterParticipationResultSchema.parse({ ...input, formatVersion: 1, participationId, claimDigest: characterClaimDigest(claim) })
    const content = `${JSON.stringify(result)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('角色参与结果超过大小限制')
    await writeFile(this.participationPath(sceneId, participationId, 'result'), content, { flag: 'wx', encoding: 'utf8' })
    return result
  }

  async readCharacterParticipation(runId: string, storyId: string, sceneId: string, participationId: string) {
    await this.readSceneSetup(runId, storyId, sceneId)
    const claim = characterParticipationClaimSchema.parse(await this.readFile(this.participationPath(sceneId, participationId, 'claim')))
    const request = claim.request
    if (request.runId !== runId || request.storyId !== storyId || request.sceneId !== sceneId || request.participationId !== participationId) throw new Error('角色参与记录身份不匹配')
    let raw: unknown
    try { raw = await this.readFile(this.participationPath(sceneId, participationId, 'result')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { claim, result: undefined }
      throw error
    }
    const result = characterParticipationResultSchema.parse(raw)
    if (result.participationId !== participationId || result.claimDigest !== characterClaimDigest(claim)) throw new Error('角色参与结果身份或摘要不匹配')
    return { claim, result }
  }

  async listCharacterParticipationIds(runId: string, storyId: string, sceneId: string) {
    await this.readSceneSetup(runId, storyId, sceneId)
    const prefix = `${sceneId}.`
    const suffix = '.character-claim.json'
    return (await readdir(this.root)).filter(name => name.startsWith(prefix) && name.endsWith(suffix)).map(name => uuid.parse(name.slice(prefix.length, -suffix.length))).sort()
  }

  private interactionPath(sceneId: string, sequence: number, kind: 'event' | 'decision' | 'dispatch' | 'actions'): string {
    return join(this.root, `${sceneId}.interaction-${z.number().int().positive().max(10000).parse(sequence)}.${kind}.json`)
  }

  async saveInteractionEvent(event: SceneInteractionEvent): Promise<void> {
    const value = sceneInteractionEventSchema.parse(event)
    const { runId, storyId, sceneId, sequence, participationId } = value
    await this.assertSceneSetupOpen(runId, storyId)
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    if (await this.readSceneResult(setup)) throw new Error('已结算场景不能追加互动事件')
    await this.verifyInteractionEvent(setup, value)
    const prior = await this.listInteractionEvents(runId, storyId, sceneId)
    if (sequence !== prior.length + 1 || prior.some(item => item.participationId === participationId)) throw new Error('互动序号或参与来源已经占用')
    const previous = prior.at(-1)
    if (previous) {
      const decision = await this.readInteractionDecision(previous)
      if (!decision || decision.next.kind === 'end' || decision.next.kind === 'review') throw new Error('场景互动尚未允许继续')
      if (decision.next.kind === 'respond') {
        const dispatch = await this.readInteractionDispatch(previous)
        if (dispatch?.record.participationId !== participationId || dispatch.participation?.outcome.status !== 'responded') throw new Error('互动事件不匹配已完成调度')
      }
    }
    const content = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景互动事件超过大小限制')
    await writeFile(this.interactionPath(sceneId, sequence, 'event'), content, { flag: 'wx', encoding: 'utf8' })
  }

  private async verifyInteractionEvent(setup: SceneSetupRecord, event: SceneInteractionEvent) {
    const { runId, storyId, sceneId } = setup
    if (event.runId !== runId || event.storyId !== storyId || event.sceneId !== sceneId || event.setupDigest !== sceneInteractionDigest(setup)) {
      throw new Error('互动事件的场景身份或版本不匹配')
    }
    const { claim, result } = await this.readCharacterParticipation(runId, storyId, sceneId, event.participationId)
    if (claim.request.characterId !== event.characterId || result?.outcome.status !== 'responded' ||
      !isDeepStrictEqual(visibleCharacterResponse(result.outcome.response), { responseKind: event.responseKind, speech: event.speech, actions: event.actions })) {
      throw new Error('互动事件和角色原始响应不匹配')
    }
  }

  async readInteractionEvent(runId: string, storyId: string, sceneId: string, sequence: number) {
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    const event = sceneInteractionEventSchema.parse(await this.readFile(this.interactionPath(sceneId, sequence, 'event')))
    if (event.sequence !== sequence) throw new Error('场景互动事件序号不匹配')
    await this.verifyInteractionEvent(setup, event)
    return event
  }

  async listInteractionEvents(runId: string, storyId: string, sceneId: string) {
    await this.readSceneSetup(runId, storyId, sceneId)
    const prefix = `${sceneId}.interaction-`
    const suffix = '.event.json'
    const files = (await readdir(this.root)).filter(name => name.startsWith(prefix))
    const sequences = files.filter(name => name.endsWith(suffix)).map(name => {
      const sequence = Number(name.slice(prefix.length, -suffix.length))
      if (name !== `${prefix}${sequence}${suffix}`) throw new Error('场景互动事件文件名无效')
      return sequence
    }).sort((left, right) => left - right)
    if (sequences.some((sequence, index) => sequence !== index + 1)) throw new Error('场景互动事件序号不连续')
    const known = new Set(sequences)
    for (const name of files.filter(name => !name.endsWith(suffix))) {
      const match = /^(\d+)\.(decision|dispatch|actions)\.json$/.exec(name.slice(prefix.length))
      if (!match || String(Number(match[1])) !== match[1] || !known.has(Number(match[1]))) throw new Error('场景互动记录缺少对应事件')
    }
    const events = await Promise.all(sequences.map(sequence => this.readInteractionEvent(runId, storyId, sceneId, sequence)))
    if (new Set(events.map(item => item.participationId)).size !== events.length) throw new Error('互动事件引用同一参与结果多次')
    return events
  }

  async saveInteractionDecision(runId: string, storyId: string, sceneId: string, decision: SceneInteractionDecision) {
    const value = sceneInteractionDecisionSchema.parse(decision)
    await this.assertSceneSetupOpen(runId, storyId)
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    if (await this.readSceneResult(setup)) throw new Error('已结算场景不能保存互动决定')
    const events = await this.listInteractionEvents(runId, storyId, sceneId)
    const event = events.at(-1)
    if (!event || event.sequence !== value.sequence || sceneInteractionDigest(event) !== value.eventDigest) throw new Error('互动决定的事件版本已变化')
    await this.resolveInteractionDecision(event, value)
    const { next } = value
    if (next.kind === 'respond' && next.trigger.kind === 'initiative') {
      const triggerId = next.trigger.id
      const previous = await Promise.all(events.slice(0, -1).map(item => this.readInteractionDecision(item)))
      if (previous.some(item => item?.next.kind === 'respond' && item.next.characterId === next.characterId &&
        item.next.trigger.kind === 'initiative' && item.next.trigger.id === triggerId)) throw new Error('独立触发依据已用')
    }
    const content = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景互动决定超过大小限制')
    await writeFile(this.interactionPath(sceneId, value.sequence, 'decision'), content, { flag: 'wx', encoding: 'utf8' })
  }

  async readInteractionDecision(event: SceneInteractionEvent) {
    const { sceneId, sequence } = event
    let raw: unknown
    try { raw = await this.readFile(this.interactionPath(sceneId, sequence, 'decision')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const decision = sceneInteractionDecisionSchema.parse(raw)
    if (decision.sequence !== sequence || decision.eventDigest !== sceneInteractionDigest(event)) throw new Error('互动决定的事件引用不匹配')
    return { ...decision, perceptions: await this.resolveInteractionDecision(event, decision) }
  }

  private async resolveInteractionDecision(event: SceneInteractionEvent, decision: SceneInteractionDecision) {
    const actions = await this.readInteractionActions(event)
    if ((event.actions.length > 0 && !actions) || decision.actionDigest !== (actions ? sceneInteractionDigest(actions) : undefined)) throw new Error('互动决定缺少匹配的行动判断')
    return resolveInteractionPerceptions(event, decision, actions)
  }

  async saveInteractionActions(event: SceneInteractionEvent, input: SceneActionRecord) {
    const record = sceneActionRecordSchema.parse(input)
    const { runId, storyId, sceneId, sequence } = event
    await this.assertSceneSetupOpen(runId, storyId)
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    if (await this.readSceneResult(setup)) throw new Error('已结算场景不能判断行动')
    if (!isDeepStrictEqual((await this.listInteractionEvents(runId, storyId, sceneId)).at(-1), event)) throw new Error('行动尝试的场景版本已变化')
    verifySceneActions(event, record)
    await writeFile(this.interactionPath(sceneId, sequence, 'actions'), `${JSON.stringify(record)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async readInteractionActions(event: SceneInteractionEvent) {
    const { sceneId, sequence } = event
    let raw: unknown
    try { raw = await this.readFile(this.interactionPath(sceneId, sequence, 'actions')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const record = sceneActionRecordSchema.parse(raw)
    verifySceneActions(event, record)
    return record
  }

  async claimInteractionDispatch(event: SceneInteractionEvent, input: SceneInteractionDispatch) {
    const { runId, storyId, sceneId } = event
    const record = sceneInteractionDispatchSchema.parse(input)
    await this.assertSceneSetupOpen(runId, storyId)
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    if (await this.readSceneResult(setup)) throw new Error('已结算场景不能调度角色')
    const events = await this.listInteractionEvents(runId, storyId, sceneId)
    if (!isDeepStrictEqual(events.at(-1), event)) throw new Error('只允许调度当前场景事件')
    await this.verifyInteractionDispatch(event, record)
    try { await writeFile(this.interactionPath(sceneId, event.sequence, 'dispatch'), `${JSON.stringify(record)}\n`, { flag: 'wx', encoding: 'utf8' }); return true }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    }
  }

  private async verifyInteractionDispatch(event: SceneInteractionEvent, record: SceneInteractionDispatch) {
    const decision = await this.readInteractionDecision(event)
    if (record.sequence !== event.sequence || decision?.next.kind !== 'respond' || decision.next.characterId !== record.characterId ||
      record.decisionDigest !== sceneInteractionDigest(decision)) throw new Error('互动调度的决定引用不匹配')
    const expected = []
    for (const reference of record.observations) {
      if (reference.sequence > event.sequence) throw new Error('互动调度不能引用未来感知')
      const source = reference.sequence === event.sequence ? event : await this.readInteractionEvent(event.runId, event.storyId, event.sceneId, reference.sequence)
      const verdict = await this.readInteractionDecision(source)
      const observation = verdict?.perceptions.find(item => item.characterId === record.characterId)?.observations[reference.index]
      if (!verdict || !observation) throw new Error('互动调度的观察引用不匹配')
      expected.push({ id: interactionObservationSource(event.sceneId, reference), version: sceneInteractionDigest(verdict), content: interactionObservationContent(observation), basis: observation.basis })
    }
    if (decision.next.trigger.kind === 'observation') {
      const index = decision.next.trigger.index
      if (!record.observations.some(item => item.sequence === event.sequence && item.index === index)) throw new Error('调度缺少本轮获准触发观察')
    }
    return expected
  }

  async readInteractionDispatch(event: SceneInteractionEvent) {
    const { runId, storyId, sceneId, sequence } = event
    let raw: unknown
    try { raw = await this.readFile(this.interactionPath(sceneId, sequence, 'dispatch')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const record = sceneInteractionDispatchSchema.parse(raw)
    const expected = await this.verifyInteractionDispatch(event, record)
    try {
      const { claim, result } = await this.readCharacterParticipation(runId, storyId, sceneId, record.participationId)
      if (claim.request.characterId !== record.characterId) throw new Error('互动调度的参与角色不匹配')
      const actual = claim.entries.filter(item => item.source.kind === 'fixed' && item.source.id.startsWith(`${sceneId}:interaction:`))
        .map(item => ({ id: item.source.id, version: item.source.version, content: item.content, basis: item.basis }))
      if (!isDeepStrictEqual(actual, expected)) throw new Error('实际角色输入与调度观察不匹配')
      return { record, participation: projectCharacterParticipation(claim, result) }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { record, participation: undefined }
      throw error
    }
  }

  private mapCheckPath(runId: string, storyId: string, id: string): string {
    return join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(id)}.map-check.json`)
  }

  async saveMapSceneCheck(check: MapSceneCheck): Promise<void> {
    const value = mapSceneCheckSchema.parse(check)
    await writeFile(this.mapCheckPath(value.runId, value.storyId, value.id), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async readMapSceneCheck(runId: string, storyId: string, id: string): Promise<MapSceneCheck> {
    const check = mapSceneCheckSchema.parse(await this.readFile(this.mapCheckPath(runId, storyId, id)))
    if (check.runId !== runId || check.storyId !== storyId || check.id !== id) throw new Error('场景地图核查身份不匹配')
    return check
  }

  private mapProposalPath(runId: string, storyId: string, checkId: string, suffix: 'claim' | 'result'): string {
    return join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(checkId)}.map-proposal-${suffix}.json`)
  }

  async claimMapProposal(runId: string, storyId: string, checkId: string): Promise<void> {
    const key = mapProposalKeySchema.parse({ formatVersion: 1, runId, storyId, checkId })
    await writeFile(this.mapProposalPath(runId, storyId, checkId, 'claim'), `${JSON.stringify(key)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async saveMapProposal(record: MapProposalRecord): Promise<void> {
    const value = mapProposalRecordSchema.parse(record)
    const { runId, storyId, checkId } = value
    await writeFile(this.mapProposalPath(runId, storyId, checkId, 'result'), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async readMapProposal(runId: string, storyId: string, checkId: string) {
    const claim = mapProposalKeySchema.parse(await this.readFile(this.mapProposalPath(runId, storyId, checkId, 'claim')))
    if (claim.runId !== runId || claim.storyId !== storyId || claim.checkId !== checkId) throw new Error('地图提案占用身份不匹配')
    let raw: unknown
    try { raw = await this.readFile(this.mapProposalPath(runId, storyId, checkId, 'result')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...claim, result: { status: 'pending' as const } }
      throw error
    }
    const value = mapProposalRecordSchema.parse(raw)
    if (value.runId !== runId || value.storyId !== storyId || value.checkId !== checkId) throw new Error('地图提案结果身份不匹配')
    return value
  }

  /** 调用方提供全部受保护目录；记录根不得与规划根重叠。 */
  static async open(root: string, planRoot: string, protectedRoots: readonly string[]): Promise<CollaborationStore> {
    await PlanStore.open(root, [...protectedRoots, planRoot])
    return new CollaborationStore(await realpath(root))
  }

  private path(planId: string, childStoryId: string, kind: 'claim' | 'simulation' | 'result'): string {
    return join(this.root, `${uuid.parse(planId)}.${uuid.parse(childStoryId)}.${kind}.json`)
  }

  private progressPath(runId: string, batch: number, kind: 'paused' | 'continued'): string {
    return join(this.root, `${uuid.parse(runId)}.${z.number().int().positive().parse(batch)}.${kind}.story.json`)
  }

  private async reviewCheckpointPaths(runId: string, batch?: number, parentStoryId?: string) {
    const prefix = `${uuid.parse(runId)}.`
    return (await readdir(this.root)).flatMap(name => {
      if (!name.startsWith(prefix)) return []
      const parts = /^(\d+)\.([0-9a-f-]{36})\.review-paused\.story\.json$/.exec(name.slice(prefix.length))
      if (!parts || (parentStoryId !== undefined && parts[2] !== parentStoryId)) return []
      const number = z.number().int().positive().parse(Number(parts[1]))
      if (String(number) !== parts[1]) throw new Error('审阅批次文件编号无效')
      return batch === undefined || batch === number ? [{ batch: number, parentStoryId: uuid.parse(parts[2]), path: join(this.root, name) }] : []
    })
  }

  private async publishReviewFile(path: string, content: string): Promise<boolean> {
    const temporary = join(this.root, `.review-${randomUUID()}.tmp`)
    await writeFile(temporary, content, { flag: 'wx', encoding: 'utf8' })
    try {
      await link(temporary, path)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    } finally {
      await unlink(temporary)
    }
  }

  /** 独占保存提前汇报或上级决定，决定必须对应已保存的汇报。 */
  async saveStoryNotice(notice: StoryNotice): Promise<void> {
    const value = storyNoticeSchema.parse(notice)
    const { runId, storyId, parentStoryId, noticeId, kind } = value
    const node = await this.readStoryNode(runId, storyId)
    if (node.parentStoryId !== parentStoryId) throw new Error('提前汇报的上级身份不匹配')
    if (kind === 'decision') {
      const report = await this.readStoryNotice(runId, storyId, noticeId, 'report')
      if (report.parentStoryId !== parentStoryId) throw new Error('提前汇报与决定的上级身份不匹配')
    }
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('提前汇报记录超过大小限制')
    await writeFile(join(this.root, `${runId}.${storyId}.${noticeId}.notice-${kind}.json`), content, { flag: 'wx', encoding: 'utf8' })
  }

  /** 读取提前汇报或上级决定，并核对故事和通知身份。 */
  async readStoryNotice(runId: string, storyId: string, noticeId: string, kind: StoryNotice['kind']): Promise<StoryNotice> {
    const path = join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(noticeId)}.notice-${kind}.json`)
    const value = storyNoticeSchema.parse(await this.readFile(path))
    if (value.runId !== runId || value.storyId !== storyId || value.noticeId !== noticeId || value.kind !== kind) throw new Error('提前汇报记录身份不匹配')
    return value
  }

  /** 保存本次正常暂停的推进位置。 */
  async saveStoryProgress(progress: StoryProgress): Promise<void> {
    const value = storyProgressSchema.parse(progress)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事暂停记录超过大小限制')
    if (value.review) {
      const path = join(this.root, `${value.runId}.${value.batch}.${value.review.parentStoryId}.review-paused.story.json`)
      if (!await this.publishReviewFile(path, content)) throw new Error('审阅批次已存在')
    } else {
      await writeFile(this.progressPath(value.runId, value.batch, 'paused'), content, { flag: 'wx', encoding: 'utf8' })
    }
  }

  /** 读取有版本的暂停记录并核对所属运行及批次。 */
  async readStoryProgress(runId: string, batch: number): Promise<StoryProgress> {
    const checkpoints = await this.reviewCheckpointPaths(runId, batch)
    if (checkpoints.length > 1) throw new Error('同一批次存在多份审阅')
    const checkpoint = checkpoints[0]
    const path = checkpoint?.path ?? this.progressPath(runId, batch, 'paused')
    const value = storyProgressSchema.parse(await this.readFile(path))
    if (value.review?.parentStoryId !== checkpoint?.parentStoryId) throw new Error('故事审阅记录身份不匹配')
    const rootId = await this.readRootStoryId(runId)
    if (value.runId !== runId || value.batch !== batch || value.frames[0]?.node.storyId !== rootId) throw new Error('故事暂停记录身份不匹配')
    return value
  }

  /** 从运行记录取得本轮根故事身份。 */
  async readRootStoryId(runId: string): Promise<string> {
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.siblings.json`)))
    if (run.planId !== runId) throw new Error('故事运行记录身份不匹配')
    return run.parentStoryId
  }

  /** 每个暂停位置只允许开始一次继续操作，失败后保留标记供核查。 */
  async claimStoryProgress(runId: string, batch: number): Promise<void> {
    try { await writeFile(this.progressPath(runId, batch, 'continued'), '', { flag: 'wx' }) }
    catch (error) { throw new Error(`故事暂停位置已使用或占用结果不明，请核查批次 ${batch}`, { cause: error }) }
  }

  /** 查找该运行最新的暂停或消费记录编号。 */
  async latestStoryBatch(runId: string): Promise<number | undefined> {
    const prefix = `${uuid.parse(runId)}.`
    let latest: number | undefined
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(prefix)) continue
      const match = /^(\d+)\.(?:paused|continued|[0-9a-f-]{36}\.review-paused)\.story\.json$/.exec(name.slice(prefix.length))
      if (!match) continue
      const batch = Number(match[1])
      if (!Number.isSafeInteger(batch) || batch < 1 || String(batch) !== match[1]) throw new Error('故事批次文件编号无效')
      if (latest === undefined || batch > latest) latest = batch
    }
    return latest
  }

  /** 检查计划或具体故事是否已有推进文件，包含部分写入后遗留的证据。 */
  async hasStoryRecords(runId: string, storyId?: string): Promise<boolean> {
    const prefix = storyId === undefined ? `${uuid.parse(runId)}.` : this.scenePrefix(runId, storyId)
    return (await readdir(this.root)).some(name => name.startsWith(prefix))
  }

  /** 只读查看批次是否已经领取，校验空消费标记。 */
  async hasContinuedStoryProgress(runId: string, batch: number): Promise<boolean> {
    const path = this.progressPath(runId, batch, 'continued')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size !== 0 || key(await realpath(path)) !== key(path)) throw new Error('故事暂停消费标记无效')
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  /** 读取已处理子故事的决定并核对身份。 */
  async readStoryChoice(runId: string, childStoryId: string): Promise<StoryChoice> {
    const value = storyChoiceSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(childStoryId)}.choice.story.json`)))
    if (value.runId !== runId || value.childStoryId !== childStoryId) throw new Error('故事决定身份不匹配')
    return value
  }

  /** 独占保存故事及其直接上级，确保上级属于同一轮运行。 */
  async saveStoryNode(node: StoryNode): Promise<void> {
    const value = storyNodeSchema.parse(node)
    if (value.parentStoryId !== null) {
      await this.readStoryNode(value.runId, value.parentStoryId)
    }
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事记录超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.storyId}.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事保存失败或结果不明，请核查故事 ${value.storyId}`, { cause: error }) }
  }

  /** 读取故事并核对运行及故事身份；损坏或未知版本不会被覆盖。 */
  async readStoryNode(runId: string, storyId: string): Promise<StoryNode> {
    const value = storyNodeSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.story.json`)))
    if (value.runId !== runId || value.storyId !== storyId) throw new Error('故事记录身份不匹配')
    return value
  }

  /** 依次独占保存拆分判断、模拟经过或回报。 */
  async saveStoryStep(step: StoryStep): Promise<void> {
    const value = storyStepSchema.parse(step)
    await this.readStoryNode(value.runId, value.storyId)
    await this.verifySceneReferences(value)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事步骤记录超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.storyId}.${value.kind}.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事步骤保存失败或结果不明，请核查故事 ${value.storyId}`, { cause: error }) }
  }

  /** 读取步骤并核对身份及版本。 */
  async readStoryStep(runId: string, storyId: string, kind: StoryStep['kind']): Promise<StoryStep> {
    const value = storyStepSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${kind}.story.json`)))
    if (value.runId !== runId || value.storyId !== storyId || value.kind !== kind) throw new Error('故事步骤身份不匹配')
    await this.verifySceneReferences(value)
    return value
  }

  private async verifySceneReferences(step: StoryStep): Promise<void> {
    if (step.kind !== 'result' || step.formatVersion === 1) return
    const decision = await this.readStoryStep(step.runId, step.storyId, 'decision')
    if (decision.kind !== 'decision' || (decision.value.kind !== 'direct' && (step.formatVersion === 2 || step.sceneIds.length))) {
      throw new Error(`场景回报须归属直接演绎的故事：${step.storyId}`)
    }
    const results = decision.value.kind === 'direct' ? await this.readSettledScenes(step.runId, step.storyId) : []
    if (results.length !== step.sceneIds.length || results.some((result, index) => result.sceneId !== step.sceneIds[index])) {
      throw new Error(`子故事回报的场景引用不匹配：${step.storyId}`)
    }
    if (step.formatVersion !== 3) return
    const { current, events } = step.worldEvidence
    if (step.worldEvidence.objectives) {
      const objectives = worldObjectivesSchema.parse(step.worldEvidence.objectives.map(item => item.objective))
      if (!isDeepStrictEqual(evaluateWorldObjectives(step.worldEvidence, objectives), step.worldEvidence.objectives)) throw new Error('故事目标结果与证据不匹配')
    }
    if (decision.value.kind === 'direct' && !isDeepStrictEqual(events.map(event => event.sceneId), results.filter(result => result.formatVersion === 2).map(result => result.sceneId))) {
      throw new Error('子故事事件未覆盖已结算的互动场景')
    }
    for (const reference of events) {
      let story = await this.readStoryNode(step.runId, reference.storyId)
      const seen = new Set<string>()
      while (story.storyId !== step.storyId) {
        if (!story.parentStoryId || seen.has(story.storyId)) throw new Error('回报事件超出当前故事分支')
        seen.add(story.storyId)
        story = await this.readStoryNode(step.runId, story.parentStoryId)
      }
      const event = await this.readSceneEvent(current.worldId, step.runId, reference.storyId, reference.sceneId)
      if (!isDeepStrictEqual(eventAssessmentEvidence(event, sceneInteractionDigest(event)), reference)) throw new Error('故事回报事件依据已变化')
    }
  }

  private scenePrefix(runId: string, storyId: string): string {
    return `${uuid.parse(runId)}.${uuid.parse(storyId)}.`
  }

  /** 故事级模拟已写入后，场景清单用于形成或核查回报。 */
  private async assertSceneSetupOpen(runId: string, storyId: string): Promise<void> {
    try {
      await this.readStoryStep(runId, storyId, 'simulation')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    throw new Error(`故事模拟已经保存，不能追加场景：${storyId}`)
  }

  /** 独占保存场景设置。程序按运行、故事和顺序分配场景身份。 */
  async saveSceneSetup(input: Omit<SceneSetupRecord, 'sceneId' | 'formatVersion'> & { mapEvidence?: SceneMapEvidence }): Promise<SceneSetupRecord> {
    const { runId, storyId, order } = input
    const sceneId = this.scenePrefix(runId, storyId) + sceneOrderSchema.parse(order)
    const record = sceneSetupRecordSchema.parse({ ...input, sceneId, formatVersion: input.mapEvidence ? 2 : 1 })
    const content = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景设置超过大小限制')
    await this.assertSceneSetupOpen(runId, storyId)
    await this.verifySceneMapEvidence(record)
    try {
      await writeFile(join(this.root, `${sceneId}.setup.scene.json`), content, { flag: 'wx', encoding: 'utf8' })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`场景身份及顺序已占用：${sceneId}`, { cause: error })
      }
      throw new Error(`场景设置保存失败或结果不明，请核查场景 ${sceneId}`, { cause: error })
    }
    return record
  }

  /** 读取并核对文件名与场景所属运行、故事和顺序。 */
  async readSceneSetup(runId: string, storyId: string, sceneId: string): Promise<SceneSetupRecord> {
    const prefix = this.scenePrefix(runId, storyId)
    if (!sceneId.startsWith(prefix)) throw new Error(`场景不属于指定的运行与故事：${sceneId}`)
    const order = sceneOrderSchema.parse(Number(sceneId.slice(prefix.length)))
    if (sceneId !== prefix + order) throw new Error(`场景身份无效：${sceneId}`)
    const record = sceneSetupRecordSchema.parse(await this.readFile(join(this.root, `${sceneId}.setup.scene.json`)))
    if (record.sceneId !== sceneId || record.runId !== runId || record.storyId !== storyId || record.order !== order) {
      throw new Error(`场景记录身份不匹配：${sceneId}`)
    }
    await this.verifySceneMapEvidence(record)
    return record
  }

  private async verifySceneMapEvidence(record: SceneSetupRecord): Promise<void> {
    const { runId, storyId } = record
    const decision = await this.readStoryStep(runId, storyId, 'decision')
    const need = decision.kind === 'decision' && 'mapNeed' in decision.value ? decision.value.mapNeed : undefined
    if (record.formatVersion === 1) {
      if (need) throw new Error('场景缺少已核对的地图资料')
      return
    }
    const { checkId, checkDigest, worldId, adoption } = record.mapEvidence
    const check = await this.readMapSceneCheck(runId, storyId, checkId)
    if (!need || check.worldId !== worldId || !isDeepStrictEqual(check.need, need) || mapRecordDigest(check) !== checkDigest) throw new Error('场景地图核查证据不匹配')
    if (check.result.status === 'ready' && !adoption) return
    if (check.result.status !== 'missing' || !adoption) throw new Error('场景地图需求尚未满足')
    const proposal = await this.readMapProposal(runId, storyId, checkId)
    if (proposal.result.status !== 'proposed' || mapRecordDigest(proposal) !== adoption.proposalDigest) throw new Error('场景地图提案证据不匹配')
  }

  /** 按故事列出已保存的场景设置，按顺序号升序返回。 */
  async listSceneSetups(runId: string, storyId: string): Promise<SceneSetupRecord[]> {
    const prefix = this.scenePrefix(runId, storyId)
    const suffix = '.setup.scene.json'
    const scenes: SceneSetupRecord[] = []
    for (const name of await readdir(this.root)) {
      if (name.startsWith(prefix) && name.endsWith(suffix)) {
        scenes.push(await this.readSceneSetup(runId, storyId, name.slice(0, -suffix.length)))
      }
    }
    return scenes.sort((a, b) => a.order - b.order)
  }

  /** 仅为已保存的设置独占写入一份模拟结果。 */
  async saveSceneResult(runId: string, storyId: string, sceneId: string, input: SceneResultInput): Promise<SceneResultRecord> {
    const setup = await this.readSceneSetup(runId, storyId, sceneId)
    const interaction = await this.interactionEvidence(setup, input.status)
    const record = sceneResultRecordSchema.parse({ ...input, runId, storyId, sceneId, ...(interaction ? { formatVersion: 2, interaction } : { formatVersion: 1 }) })
    const content = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景结果超过大小限制')
    try {
      await writeFile(join(this.root, `${sceneId}.result.scene.json`), content, { flag: 'wx', encoding: 'utf8' })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`场景结果已存在：${sceneId}`, { cause: error })
      }
      throw new Error(`场景结果保存失败或结果不明，请核查场景 ${sceneId}`, { cause: error })
    }
    return record
  }

  /** 重读已验证设置的模拟结果，结果不存在时返回 undefined。 */
  async readSceneResult(setup: SceneSetupRecord): Promise<SceneResultRecord | undefined> {
    const { runId, storyId, order } = setup
    const sceneId = this.scenePrefix(runId, storyId) + sceneOrderSchema.parse(order)
    let data: unknown
    try {
      data = await this.readFile(join(this.root, `${sceneId}.result.scene.json`))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const result = sceneResultRecordSchema.parse(data)
    if (result.sceneId !== sceneId || result.runId !== runId || result.storyId !== storyId) {
      throw new Error(`场景结果身份不匹配：${sceneId}`)
    }
    const evidence = await this.interactionEvidence(setup, result.status)
    if (!isDeepStrictEqual(evidence, result.formatVersion === 2 ? result.interaction : undefined)) throw new Error('场景结果与互动证据不匹配')
    return result
  }

  private async interactionEvidence(setup: SceneSetupRecord, status: SceneResultInput['status']) {
    const events = await this.listInteractionEvents(setup.runId, setup.storyId, setup.sceneId)
    if (!events.length) return undefined
    const steps = []
    for (const [index, event] of events.entries()) {
      const decision = await this.readInteractionDecision(event)
      if (!decision) throw new Error('场景存在未判定的互动事件')
      const dispatch = await this.readInteractionDispatch(event)
      const next = events[index + 1]
      if (next && (decision.next.kind === 'end' || decision.next.kind === 'review' ||
        (decision.next.kind === 'respond' && (dispatch?.record.participationId !== next.participationId || dispatch?.participation?.outcome.status !== 'responded')))) {
        throw new Error('场景互动顺序或参与结果不匹配')
      }
      if (!next && (status === 'unresolved' ? decision.next.kind !== 'review' && decision.next.kind !== 'wait' : decision.next.kind !== 'end')) {
        throw new Error('场景互动尚无对应的结束或待核查决定')
      }
      steps.push({ event, decision, dispatch })
    }
    return { sequence: events.length, digest: sceneInteractionDigest(steps) }
  }

  /** 读取按顺序结算的场景。缺少结果或结果未决时拒绝形成回报。 */
  async readSettledScenes(runId: string, storyId: string): Promise<SceneResultRecord[]> {
    const results: SceneResultRecord[] = []
    for (const setup of await this.listSceneSetups(runId, storyId)) {
      const result = await this.readSceneResult(setup)
      if (!result || result.status === 'unresolved') throw new Error(`场景尚未结算：${setup.sceneId}`)
      results.push(result)
    }
    return results
  }

  /** 记录上级对当前未执行子故事的决定，包括取消。 */
  async saveStoryChoice(choice: StoryChoice): Promise<void> {
    const value = storyChoiceSchema.parse(choice)
    await this.readStoryNode(value.runId, value.parentStoryId)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事决定超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.childStoryId}.choice.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事决定保存失败或结果不明，请核查故事 ${value.childStoryId}`, { cause: error }) }
  }

  /** 独占创建本轮父故事身份，避免将已有尝试自动当成可恢复进度。 */
  async startSiblings(planId: string, parentStoryId: string): Promise<void> {
    const value = siblingRunSchema.parse({ formatVersion: 1, planId, parentStoryId })
    try { await writeFile(join(this.root, `${value.planId}.siblings.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`兄弟故事已有运行或创建结果不明，请核查规划 ${planId}`, { cause: error }) }
  }

  /** 保存每个未发生事件的导演决定；已保存决定不会被覆盖。 */
  async saveSiblingDecision(decision: SiblingDecision): Promise<void> {
    const value = siblingDecisionSchema.parse(decision)
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${value.planId}.siblings.json`)))
    if (run.planId !== value.planId || run.parentStoryId !== value.parentStoryId) throw new Error('兄弟故事身份不匹配')
    try { await writeFile(join(this.root, `${value.planId}.${value.childStoryId}.decision.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`决定保存失败或结果不明，请核查事件 ${value.childStoryId}`, { cause: error }) }
  }

  /** 读取并核对兄弟故事决定与本轮父故事身份。 */
  async readSiblingDecision(planId: string, childStoryId: string): Promise<SiblingDecision> {
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${uuid.parse(planId)}.siblings.json`)))
    const value = siblingDecisionSchema.parse(await this.readFile(join(this.root, `${uuid.parse(planId)}.${uuid.parse(childStoryId)}.decision.json`)))
    if (run.planId !== planId || value.planId !== planId || value.childStoryId !== childStoryId || value.parentStoryId !== run.parentStoryId) throw new Error('兄弟故事决定身份不匹配')
    return value
  }

  /** 保存模拟经过供中断后核查；不代表子故事完成。 */
  async saveSimulation(record: SimulationRecord): Promise<void> {
    const valid = simulationRecordSchema.parse(record)
    const claim = claimSchema.parse(await this.readFile(this.path(valid.planId, valid.childStoryId, 'claim')))
    if (claim.planId !== valid.planId || claim.childStoryId !== valid.childStoryId || claim.collaborationId !== valid.collaborationId) throw new Error('协作占用身份不匹配')
    const content = `${JSON.stringify(valid, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('模拟记录超过大小限制')
    try { await writeFile(this.path(valid.planId, valid.childStoryId, 'simulation'), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`模拟记录写入失败或不明，请核查事件 ${valid.childStoryId}`, { cause: error }) }
  }

  /** 读取模拟经过并核对占用身份。 */
  async readSimulation(planId: string, childStoryId: string): Promise<SimulationRecord> {
    const claim = claimSchema.parse(await this.readFile(this.path(planId, childStoryId, 'claim')))
    const record = simulationRecordSchema.parse(await this.readFile(this.path(planId, childStoryId, 'simulation')))
    if (claim.planId !== planId || claim.childStoryId !== childStoryId || record.planId !== planId || record.childStoryId !== childStoryId || record.collaborationId !== claim.collaborationId) throw new Error('模拟记录身份不匹配')
    return record
  }

  /** 在执行导演或模拟器之前独占占用；失败后保留，禁止自动重试。 */
  async claim(planId: string, childStoryId: string, collaborationId: string): Promise<void> {
    const claim = claimSchema.parse({ formatVersion: 1, planId, childStoryId, collaborationId })
    try { await writeFile(this.path(planId, childStoryId, 'claim'), `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`事件已有尝试或占用结果不明，请核查事件 ${childStoryId}`, { cause: error }) }
  }

  private async readFile(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(path)) !== key(path) || info.size > 1024 * 1024) throw new Error('协作记录文件无效')
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) throw new Error('协作记录超过大小限制')
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }

  /** 独占保存最终结果；失败时保留文件和占用供核查。 */
  async save(record: Collaboration): Promise<void> {
    const valid = collaborationSchema.parse(record)
    const claim = claimSchema.parse(await this.readFile(this.path(valid.plan.id, valid.childStoryId, 'claim')))
    if (claim.planId !== valid.plan.id || claim.childStoryId !== valid.childStoryId || claim.collaborationId !== valid.id) throw new Error('协作占用身份不匹配')
    const simulation = await this.readSimulation(valid.plan.id, valid.childStoryId)
    if (JSON.stringify(simulation.simulation) !== JSON.stringify(valid.simulation) || JSON.stringify(simulation.task) !== JSON.stringify(valid.task) || simulation.preparation !== valid.preparation) throw new Error('模拟经过与协作结果不一致')
    const content = `${JSON.stringify(valid, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('协作记录超过大小限制')
    try { await writeFile(this.path(valid.plan.id, valid.childStoryId, 'result'), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`协作结果写入失败或不明，请核查事件 ${valid.childStoryId}`, { cause: error }) }
  }

  /** 读取并核对记录与占用身份；未知版本或损坏保留原文件。 */
  async read(planId: string, childStoryId: string): Promise<Collaboration> {
    const claim = claimSchema.parse(await this.readFile(this.path(planId, childStoryId, 'claim')))
    const record = collaborationSchema.parse(await this.readFile(this.path(planId, childStoryId, 'result')))
    if (claim.planId !== planId || claim.childStoryId !== childStoryId || record.plan.id !== planId || record.childStoryId !== childStoryId || record.id !== claim.collaborationId) throw new Error('协作记录身份不匹配')
    const simulation = await this.readSimulation(planId, childStoryId)
    if (JSON.stringify(simulation.simulation) !== JSON.stringify(record.simulation) || JSON.stringify(simulation.task) !== JSON.stringify(record.task) || simulation.preparation !== record.preparation) throw new Error('模拟经过与协作结果不一致')
    return record
  }
}
