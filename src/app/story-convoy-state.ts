import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { convoyBaselineSchema, convoyBaselineSourceSchema, convoyChangeSchema, convoyIdentitySchema, convoyOperationName, convoyProposalSchema,
  isMissingStoryFile, publishConvoyRecord, readConvoyRecord, type ConvoyBaseline, type ConvoyChange, type ConvoyProposal } from '../story-workflow/convoy-state.js'
import type { SceneEvent } from '../story-workflow/scene-event.js'
import { sceneInteractionDigest } from '../story-workflow/scene-interaction.js'
import { PlanStore } from '../story-workflow/store.js'
import { openStoryEvents } from './story-event.js'

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
  const events = openStoryEvents({ ...roots, protectedRoots: [...roots.protectedRoots, root, options.worldRoot] }, { worldId: identity.worldId, runId })
  const baselineFile = 'convoy-0.json'

  function verifyIdentity(value: typeof identity) {
    if (value.worldId !== identity.worldId || value.convoyId !== identity.convoyId) throw new Error('商队状态世界或目标身份不匹配')
  }

  async function read(): Promise<ConvoyBaseline> {
    const value = await readConvoyRecord(root, baselineFile, convoyBaselineSchema)
    verifyIdentity(value)
    return value
  }

  async function readChange(operationId: string): Promise<ConvoyChange> {
    const change = await readConvoyRecord(root, convoyOperationName(operationId), convoyChangeSchema)
    verifyIdentity(change.proposal)
    if (change.proposal.operationId !== operationId || change.proposal.evidence.runId !== runId) throw new Error('商队状态操作身份不匹配')
    return change
  }

  async function verifyEvidence(proposal: ConvoyProposal) {
    const { actionIndex, sequence, eventId, ...source } = proposal.evidence
    const event = await events.read(source)
    if (event.eventId !== eventId) throw new Error('商队状态变化的事件版本已变化')
    const action = event.sequence.find(item => item.order === sequence)?.actions.find(item => item.index === actionIndex)
    if (!action || action.status !== 'succeeded' || !action.ruleAllowed || !action.observable) throw new Error('缺少已经确认的商队行动结果')
    return { event, action }
  }

  return Object.freeze({ worldId: identity.worldId, convoyId: identity.convoyId, runId, read, readChange,
    async initialize(source: ConvoyBaseline['source']) {
      const baseline: ConvoyBaseline = { ...identity, formatVersion: 1, revision: 0, status: 'arrived', source: convoyBaselineSourceSchema.parse(source) }
      if (!await publishConvoyRecord(root, baselineFile, baseline) && !isDeepStrictEqual(await read(), baseline)) throw new Error('商队已有不同初始状态')
      return baseline
    },
    async prepare(input: ConvoyProposal) {
      const proposal = convoyProposalSchema.parse(input)
      verifyIdentity(proposal)
      let existing: ConvoyChange | undefined
      try { existing = await readChange(proposal.operationId) }
      catch (error) { if (!isMissingStoryFile(error)) throw error }
      if (existing) {
        if (!isDeepStrictEqual(existing.proposal, proposal)) throw new Error('同一商队状态操作的内容已变化')
        return existing
      }
      if (!authorize) throw new Error('无权准备商队状态变化')
      const baseline = await read()
      if (baseline.revision !== proposal.expectedRevision) throw new Error('商队状态预期版本已变化')
      const { event, action } = await verifyEvidence(proposal)
      const authorization = await authorize(structuredClone({ proposal, event, action }))
      if (!authorization) throw new Error('商队状态变化未获授权')
      const change = convoyChangeSchema.parse({ formatVersion: 1, proposal, expectedDigest: sceneInteractionDigest(baseline), eventDigest: sceneInteractionDigest(event), authorization })
      if (!await publishConvoyRecord(root, convoyOperationName(proposal.operationId), change) && !isDeepStrictEqual(await readChange(proposal.operationId), change)) {
        throw new Error('同一商队状态操作的内容已变化')
      }
      return change
    },
  })
}
