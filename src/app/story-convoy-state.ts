import { readdir, realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { convoyBaselineSchema, convoyBaselineSourceSchema, convoyChangeSchema, convoyCommittedSchema, convoyIdentitySchema, convoyOperationName, convoyProposalSchema,
  isMissingStoryFile, publishConvoyRecord, readConvoyRecord, type ConvoyBaseline, type ConvoyChange, type ConvoyProposal, type ConvoyReceipt, type ConvoyState } from '../story-workflow/convoy-state.js'
import type { SceneEvent } from '../story-workflow/scene-event.js'
import { sceneInteractionDigest } from '../story-workflow/scene-interaction.js'
import { eventAssessmentEvidence, type StoryWorldProgressSource } from '../story-workflow/world-progress.js'
import { PlanStore } from '../story-workflow/store.js'
import { openStoryEvents } from './story-event.js'
import { currentScheduledScene } from './story-schedule-context.js'

type Roots = Parameters<typeof openStoryEvents>[0]
type Action = SceneEvent['sequence'][number]['actions'][number]
export type AuthorizeConvoyChange = (input: { proposal: ConvoyProposal; event: SceneEvent; action: Action }) => Promise<string | undefined>

/** 绑定独立的世界运行状态根，调用方明确选择本次可更新的商队和地点依据。 */
export async function openStoryConvoyState(roots: Roots, options: { worldId: string; runId: string; convoyId: string; stateRoot: string; worldRoot: string;
  authorize?: AuthorizeConvoyChange }) {
  const identity = convoyIdentitySchema.parse({ worldId: options.worldId, convoyId: options.convoyId })
  const { runId, authorize } = options
  await PlanStore.open(options.stateRoot, [roots.planRoot, roots.collaborationRoot, options.worldRoot, ...roots.protectedRoots])
  const root = await realpath(options.stateRoot)
  const eventRoots = { ...roots, protectedRoots: [...roots.protectedRoots, root, options.worldRoot] }
  const events = openStoryEvents(eventRoots, { worldId: identity.worldId, runId })
  const baselineFile = 'convoy-0.json'
  const committedFile = 'convoy-1.json'

  function verifyIdentity(value: typeof identity) {
    if (value.worldId !== identity.worldId || value.convoyId !== identity.convoyId) throw new Error('商队状态世界或目标身份不匹配')
  }

  async function readBaseline(): Promise<ConvoyBaseline> {
    const value = await readConvoyRecord(root, baselineFile, convoyBaselineSchema)
    verifyIdentity(value)
    return value
  }

  async function read(): Promise<ConvoyState> {
    const baseline = await readBaseline()
    let current
    try { current = await readConvoyRecord(root, committedFile, convoyCommittedSchema) }
    catch (error) { if (isMissingStoryFile(error)) return baseline; throw error }
    verifyIdentity(current)
    if (current.change.expectedDigest !== sceneInteractionDigest(baseline)) throw new Error('商队状态版本未衔接')
    return current
  }

  async function readChange(operationId: string): Promise<ConvoyChange> {
    const change = await readConvoyRecord(root, convoyOperationName(operationId), convoyChangeSchema)
    verifyIdentity(change.proposal)
    if (change.proposal.operationId !== operationId || change.proposal.evidence.runId !== runId) throw new Error('商队状态操作身份不匹配')
    return change
  }

  async function verifyEvidence(proposal: ConvoyProposal, source = events) {
    const { actionIndex, sequence, eventId, ...sourceIdentity } = proposal.evidence
    const event = await source.read(sourceIdentity)
    if (event.eventId !== eventId) throw new Error('商队状态变化的事件版本已变化')
    const action = event.sequence.find(item => item.order === sequence)?.actions.find(item => item.index === actionIndex)
    if (!action || action.status !== 'succeeded' || !action.ruleAllowed || !action.observable) throw new Error('缺少已经确认的商队行动结果')
    return { event, action }
  }

  async function inspect(operationId: string): Promise<ConvoyReceipt> {
    convoyOperationName(operationId)
    try {
      const current = await read()
      if (current.status === 'waiting' && current.change.proposal.operationId === operationId) {
        const { event } = await verifyEvidence(current.change.proposal)
        if (current.change.eventDigest !== sceneInteractionDigest(event)) throw new Error('已应用状态的事件证据已变化')
        return { status: 'applied', operationId, state: current }
      }
      let change: ConvoyChange
      try { change = await readChange(operationId) }
      catch (error) {
        if (isMissingStoryFile(error)) return { status: 'not-applied', operationId, reason: '未发现获准操作或已提交状态' }
        throw error
      }
      if (current.revision !== change.proposal.expectedRevision || sceneInteractionDigest(current) !== change.expectedDigest) {
        return { status: 'conflict', operationId, reason: '当前商队状态与获准操作的期望版本不同' }
      }
      return { status: 'not-applied', operationId, reason: '有获准操作，当前状态尚未变化' }
    } catch (error) {
      return { status: 'unknown', operationId, reason: error instanceof Error ? error.message : '商队操作结果无法核查' }
    }
  }

  async function apply(operationId: string, signal?: AbortSignal): Promise<ConvoyReceipt> {
    signal?.throwIfAborted()
    if (!authorize) throw new Error('无权应用商队状态变化')
    const permit = currentScheduledScene()
    if (permit) {
      const saved = await readChange(operationId)
      permit.assertConvoyWrite(root, saved.proposal)
      if (saved.expectedDigest !== permit.state?.digest) throw new Error('商队获准操作与排期准入摘要不匹配')
    }
    const prior = await inspect(operationId)
    if (prior.status !== 'not-applied') return prior
    let change
    try { change = await readChange(operationId) }
    catch (error) { if (isMissingStoryFile(error)) return prior; throw error }
    const { proposal } = change
    const { event, action } = await verifyEvidence(proposal)
    if (change.eventDigest !== sceneInteractionDigest(event)) throw new Error('已授权状态变化的事件证据已变化')
    if (await authorize(structuredClone({ proposal, event, action })) !== change.authorization) return { status: 'not-applied', operationId, reason: '操作授权已变化' }
    const current = await read()
    if (current.revision !== proposal.expectedRevision || sceneInteractionDigest(current) !== change.expectedDigest) return inspect(operationId)
    const record = convoyCommittedSchema.parse({ ...identity, formatVersion: 1, revision: 1, status: 'waiting', locationId: proposal.locationId, change })
    signal?.throwIfAborted()
    permit?.assertConvoyWrite(root, proposal)
    try { await publishConvoyRecord(root, committedFile, record) }
    catch (error) {
      const receipt = await inspect(operationId)
      if (receipt.status === 'applied' || receipt.status === 'conflict') return receipt
      return { ...receipt, reason: `状态发布失败，核查结果为${receipt.reason}。${error instanceof Error ? error.message : ''}` }
    }
    return inspect(operationId)
  }

  const progress: StoryWorldProgressSource = Object.freeze({
    worldId: identity.worldId, runId,
    async current() {
      const permit = currentScheduledScene()
      if (permit) return permit.readConvoy(root, identity.worldId, runId, identity.convoyId)
      const current = await read()
      const stamp = { ...identity, digest: sceneInteractionDigest(current) }
      if (current.status === 'waiting') {
        const { proposal } = current.change
        try {
          const source = proposal.evidence.runId === runId ? events : openStoryEvents(eventRoots, { worldId: identity.worldId, runId: proposal.evidence.runId })
          const { event } = await verifyEvidence(proposal, source)
          if (sceneInteractionDigest(event) !== current.change.eventDigest) throw new Error('状态的事件摘要已变化')
        } catch (error) {
          throw new Error('当前商队状态的应用回执待核查', { cause: error })
        }
        return { ...stamp, status: 'waiting' as const, revision: 1 as const, locationId: current.locationId,
          operationId: proposal.operationId, eventId: proposal.evidence.eventId }
      }
      const operations = (await readdir(root)).filter(name => name.startsWith('operation-') && name.endsWith('.json'))
      if (operations.length) throw new Error('商队已有尚未应用的获准操作，请先核查')
      return { ...stamp, status: 'arrived' as const, revision: 0 as const }
    },
    async event(storyId: string, sceneId: string) {
      const event = await events.read({ runId, storyId, sceneId })
      return eventAssessmentEvidence(event, sceneInteractionDigest(event))
    },
  })

  return Object.freeze({ worldId: identity.worldId, convoyId: identity.convoyId, runId, stateRoot: root,
    async initialEvidence() {
      const permit = currentScheduledScene()
      if (permit) return permit.readConvoy(root, identity.worldId, runId, identity.convoyId)
      const baseline = await readBaseline()
      return { ...identity, status: 'arrived' as const, revision: 0 as const, digest: sceneInteractionDigest(baseline) }
    },
    async read() {
      const expected = currentScheduledScene()?.readConvoy(root, identity.worldId, runId, identity.convoyId)
      const result = await read()
      if (expected && sceneInteractionDigest(result) !== expected.digest) throw new Error('商队状态已越过场景准入版本')
      return result
    },
    readChange, inspect, apply, progress,
    async initialize(source: ConvoyBaseline['source']) {
      if (currentScheduledScene()) throw new Error('场景执行期间不能初始化商队')
      const baseline: ConvoyBaseline = { ...identity, formatVersion: 1, revision: 0, status: 'arrived', source: convoyBaselineSourceSchema.parse(source) }
      if (!await publishConvoyRecord(root, baselineFile, baseline) && !isDeepStrictEqual(await readBaseline(), baseline)) throw new Error('商队已有不同初始状态')
      return baseline
    },
    async prepare(input: ConvoyProposal) {
      const proposal = convoyProposalSchema.parse(input)
      verifyIdentity(proposal)
      const permit = currentScheduledScene()
      permit?.assertConvoyWrite(root, proposal)
      let existing: ConvoyChange | undefined
      try { existing = await readChange(proposal.operationId) }
      catch (error) { if (!isMissingStoryFile(error)) throw error }
      if (existing) {
        if (!isDeepStrictEqual(existing.proposal, proposal)) throw new Error('同一商队状态操作的内容已变化')
        if (permit && existing.expectedDigest !== permit.state?.digest) throw new Error('商队获准操作与排期准入摘要不匹配')
        return existing
      }
      if (!authorize) throw new Error('无权准备商队状态变化')
      const baseline = await read()
      if (baseline.revision !== proposal.expectedRevision) throw new Error('商队状态预期版本已变化')
      if (permit && sceneInteractionDigest(baseline) !== permit.state?.digest) throw new Error('商队状态已越过场景准入版本')
      const { event, action } = await verifyEvidence(proposal)
      const authorization = await authorize(structuredClone({ proposal, event, action }))
      if (!authorization) throw new Error('商队状态变化未获授权')
      const change = convoyChangeSchema.parse({ formatVersion: 1, proposal, expectedDigest: sceneInteractionDigest(baseline), eventDigest: sceneInteractionDigest(event), authorization })
      permit?.assertConvoyWrite(root, proposal)
      if (!await publishConvoyRecord(root, convoyOperationName(proposal.operationId), change) && !isDeepStrictEqual(await readChange(proposal.operationId), change)) {
        throw new Error('同一商队状态操作的内容已变化')
      }
      return change
    },
  })
}
