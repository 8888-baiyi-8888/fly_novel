import type { CollaborationStore } from './store.js'
import { openStory } from './story-query.js'
import { sceneSetupInputSchema, type SceneSetupInput, type SceneSetupRecord } from './types.js'

type SceneOptions = Parameters<typeof openStory>[0]

async function openForScene(options: SceneOptions, planId: string, storyId: string) {
  const story = await openStory(options, planId, storyId)
  if (story.decision?.kind !== 'direct') throw new Error(`场景须归属已确定直接演绎的故事：${storyId}`)
  return story.store
}

async function sceneView(store: CollaborationStore, setup: SceneSetupRecord) {
  const result = await store.readSceneResult(setup)
  return result ? { ...setup, status: result.status, result } : { ...setup, status: 'pending' as const }
}

/** 保存一个待演绎的场景设置。指定顺序已被占用时抛错，保留原记录。 */
export async function createStoryScene(options: SceneOptions, planId: string, storyId: string, input: SceneSetupInput) {
  const setup = sceneSetupInputSchema.parse(input)
  const store = await openForScene(options, planId, storyId)
  const record = await store.saveSceneSetup({ ...setup, runId: planId, storyId })
  return { ...record, status: 'pending' as const }
}

/** 按场景身份读取设置，场景必须属于所指定的运行和故事。 */
export async function readStoryScene(options: SceneOptions, planId: string, storyId: string, sceneId: string) {
  const store = await openForScene(options, planId, storyId)
  const record = await store.readSceneSetup(planId, storyId, sceneId)
  return sceneView(store, record)
}

/** 列出指定故事的已保存设置，按场景顺序升序返回。 */
export async function listStoryScenes(options: SceneOptions, planId: string, storyId: string) {
  const store = await openForScene(options, planId, storyId)
  const records = await store.listSceneSetups(planId, storyId)
  return Promise.all(records.map(record => sceneView(store, record)))
}
