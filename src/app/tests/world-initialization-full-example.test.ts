import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import type { WorldInitializationWorkflow as Workflow } from '../world-initialization-workflow.js'
import { runWorldInitializationFullExample, sampleInput } from '../world-initialization-full-example.js'
import { inspectInitialSampleResume } from '../world-initialization-resume.js'

class ScriptedModel extends LlmAdapter {
  private step = 0
  constructor(private readonly discussion: boolean) { super() }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.step++ === 0) {
      const name = this.discussion ? 'discussion_prepare' : 'save_first_world_plan'
      const args = this.discussion ? { content: '# 城邦世界\n夜间关闭城门，紧急医疗运输可以申请通行。', summary: '修改城门规则' }
        : { content: '# 城邦世界\n曲水城夜间关闭城门，外海留白。' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'sample' as ToolCallId, name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '结果已保存。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实模型样例的分步流程使用模拟确认、保存候选并交付', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  const result = await runWorldInitializationFullExample(sampleInput, text => output.push(text))
  t.after(() => rm(result.root, { recursive: true, force: true }))
  assert.equal(calls, 3)
  assert.ok(output.some(line => line.includes('模拟用户确认')))
  assert.ok(output.some(line => line.includes('主 Agent 第 1 步开始')))
  assert.ok(output.some(line => line.includes('开始调用工具 save_first_world_plan')))
  assert.ok(output.some(line => line.includes('工具 save_first_world_plan已返回：调用未报错')))
  assert.ok(output.some(line => line.includes('开始调用工具 discussion_prepare')))
  assert.ok(output.some(line => line.includes('空发现不代表不存在冲突')))
  const delivery: unknown = JSON.parse(await readFile(join(result.root, 'delivery', 'deliveries', `${result.deliveryId}.json`), 'utf8'))
  assert.ok(delivery && typeof delivery === 'object' && 'worldId' in delivery && delivery.worldId === result.worldId)
  const plans = await readdir(join(result.root, 'world', 'main'))
  assert.equal(plans.length, 1)
  assert.match(await readFile(join(result.root, 'world', 'main', plans[0]!), 'utf8'), /医疗运输/)
})

test('示例确认字符串不匹配时不会进入讨论或交付', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample({ ...sampleInput, firstVersionDecision: '还没确认' }, text => output.push(text)), /未确认第一版/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await readdir(join(root, 'discussion', 'discussions')), [])
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})

test('候选审阅字符串不匹配时保留候选且不改写正文', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample({ ...sampleInput, reviewDecision: '暂不确认' }, text => output.push(text)), /未确认候选/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidates = await readdir(join(root, 'discussion', 'candidates'))
  assert.equal(candidates.length, 1)
  const plans = await readdir(join(root, 'world', 'main'))
  const original = await readFile(join(root, 'world', 'main', plans[0]!), 'utf8')
  assert.doesNotMatch(original, /紧急医疗运输可以申请通行/)
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})

class FailFirstModel extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟中断', code: 'PROVIDER_ERROR' } } }
  }
}

test('第一版中断后复用原任务与会话，保留已有模块资料并继续到交付', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => {
    calls++
    return { provider, model: 'fixed', adapter: calls === 2 ? new FailFirstModel() : new ScriptedModel(calls >= 5) }
  })
  const firstOutput: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => firstOutput.push(text)), /模拟中断/)
  const root = firstOutput.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'world', 'basics', 'existing.md'), '已有基础资料', { flag: 'wx' })
  const before = await readFile(join(root, 'task', 'tasks', (await readdir(join(root, 'task', 'tasks')))[0]!), 'utf8')
  const task: unknown = JSON.parse(before)
  assert.ok(task && typeof task === 'object' && 'worldId' in task && typeof task.worldId === 'string')
  await writeFile(join(root, 'world', 'characters', 'index.json'), '{"formatVersion":1,"characters":[]}\n', { flag: 'wx' })
  await mkdir(join(root, 'world', 'characters', 'relationships'))
  const sessionContext = new Context(); const backend = await sessionContext.plugin(jsonlSessionPersistencePlugin, { root: join(root, 'sessions') })
  const id = `character-creator-${createHash('sha256').update(JSON.stringify([task.worldId, 'characters', 'characters'])).digest('hex')}`
  const handle = await sessionContext.sessionPersistence.create({ id, createdAt: new Date().toISOString() }); await handle.close(); await backend.dispose()
  const inspected = await inspectInitialSampleResume(root)
  assert.equal(inspected.modes.characters, 'resume')
  assert.equal(inspected.initializeCharacters, false)
  assert.equal(inspected.enabled.has('characters'), true)
  const resumedOutput: string[] = []
  const result = await runWorldInitializationFullExample(sampleInput, text => resumedOutput.push(text), { resumeRoot: root })
  assert.equal(result.root, root)
  assert.equal(await readFile(join(root, 'world', 'basics', 'existing.md'), 'utf8'), '已有基础资料')
  assert.equal(await readFile(join(root, 'task', 'tasks', `${result.taskId}.json`), 'utf8'), before)
  assert.ok(resumedOutput.some(line => line.includes('已暂停可能重复写入的专用 Agent') && line.includes('basics')))
  assert.equal((await readdir(join(root, 'delivery', 'deliveries'))).length, 1)
})

test('续跑发现第一版总览时保留记录并拒绝推断第一版完整', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample({ ...sampleInput, firstVersionDecision: '还没确认' }, line => output.push(line)), /未确认第一版/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const plan = (await readdir(join(root, 'world', 'main')))[0]!
  const before = await readFile(join(root, 'world', 'main', plan), 'utf8')
  await assert.rejects(runWorldInitializationFullExample(sampleInput, () => {}, { resumeRoot: root }), /已有成果或总览/)
  assert.equal(await readFile(join(root, 'world', 'main', plan), 'utf8'), before)
})

test('确认已保存后中断，续跑复用候选与审阅并继续发布', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const { WorldInitializationWorkflow } = await import('../world-initialization-workflow.js')
  const original = WorldInitializationWorkflow.prototype.submit
  const intercept = t.mock.method(WorldInitializationWorkflow.prototype, 'submit', function(this: Workflow, ..._args: Parameters<typeof original>) {
    throw new Error('模拟确认后中断')
  })
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟确认后中断/)
  intercept.mock.restore()
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstReviewFiles = await readdir(join(root, 'review', 'reviews'))
  const firstCandidateFiles = await readdir(join(root, 'discussion', 'candidates'))
  const result = await runWorldInitializationFullExample(sampleInput, () => {}, { resumeRoot: root })
  assert.equal(result.root, root)
  assert.deepEqual(await readdir(join(root, 'review', 'reviews')), firstReviewFiles)
  assert.deepEqual(await readdir(join(root, 'discussion', 'candidates')), firstCandidateFiles)
  assert.equal((await readdir(join(root, 'delivery', 'deliveries'))).length, 1)
  const repeated = await runWorldInitializationFullExample(sampleInput, () => {}, { resumeRoot: root })
  assert.equal(repeated.deliveryId, result.deliveryId)
  assert.equal(calls, 3, '已有候选与交付时不能重新调用模型')
})

test('发布成功后响应丢失，续跑核对已发布正文且不重复发布', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const { WorldInitializationWorkflow } = await import('../world-initialization-workflow.js')
  const original = WorldInitializationWorkflow.prototype.submit
  const intercept = t.mock.method(WorldInitializationWorkflow.prototype, 'submit', async function(this: Workflow, ...args: Parameters<typeof original>) {
    await original.apply(this, args)
    throw new Error('模拟发布响应丢失')
  })
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟发布响应丢失/)
  intercept.mock.restore()
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = await readdir(join(root, 'batch'))
  const before = await readFile(join(root, 'batch', files[0]!), 'utf8')
  const resumedOutput: string[] = []
  const result = await runWorldInitializationFullExample(sampleInput, text => resumedOutput.push(text), { resumeRoot: root })
  assert.equal(await readFile(join(root, 'batch', files[0]!), 'utf8'), before)
  assert.ok(resumedOutput.some(line => line.includes('不重复发布')))
  assert.ok(await readFile(join(root, 'delivery', 'deliveries', `${result.deliveryId}.json`), 'utf8'))
})

test('发布状态不确定时续跑停止并保留记录', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const { WorldInitializationWorkflow } = await import('../world-initialization-workflow.js')
  const original = WorldInitializationWorkflow.prototype.submit
  const intercept = t.mock.method(WorldInitializationWorkflow.prototype, 'submit', async function(this: Workflow, ...args: Parameters<typeof original>) {
    await original.apply(this, args)
    throw new Error('模拟发布响应丢失')
  })
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟发布响应丢失/)
  intercept.mock.restore()
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root); t.after(() => rm(root, { recursive: true, force: true }))
  const filename = (await readdir(join(root, 'batch')))[0]!
  const path = join(root, 'batch', filename)
  const stored: unknown = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(stored && typeof stored === 'object')
  const uncertain = JSON.stringify({ ...stored, state: 'running' })
  await writeFile(path, uncertain)
  await assert.rejects(runWorldInitializationFullExample(sampleInput, () => {}, { resumeRoot: root }), /发布未完成或结果不确定/)
  assert.equal(await readFile(path, 'utf8'), uncertain)
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})

test('存在最终审阅但交付结果不明时不自动重复完成', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const { WorldInitializationWorkflow } = await import('../world-initialization-workflow.js')
  const intercept = t.mock.method(WorldInitializationWorkflow.prototype, 'completeDelivery', function() { throw new Error('模拟完成响应不确定') })
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟完成响应不确定/)
  intercept.mock.restore()
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root); t.after(() => rm(root, { recursive: true, force: true }))
  const reviews = await readdir(join(root, 'delivery', 'reviews'))
  await assert.rejects(runWorldInitializationFullExample(sampleInput, () => {}, { resumeRoot: root }), /结果可能不确定/)
  assert.deepEqual(await readdir(join(root, 'delivery', 'reviews')), reviews)
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})

test('续跑遇到不完整的 Session 尾行时拒绝并保留原文件', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: calls++ === 1 ? new FailFirstModel() : new ScriptedModel(false) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟中断/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root); t.after(() => rm(root, { recursive: true, force: true }))
  const folder = (await readdir(join(root, 'sessions')))[0]!
  const path = join(root, 'sessions', folder, 'session.v2.jsonl')
  await appendFile(path, '{"incomplete":')
  const before = await readFile(path)
  await assert.rejects(inspectInitialSampleResume(root), /未完成的尾行/)
  assert.deepEqual(await readFile(path), before)
})

test('第一版中断后在新进程续跑同一任务', { timeout: 40000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: calls++ === 1 ? new FailFirstModel() : new ScriptedModel(false) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample(sampleInput, text => output.push(text)), /模拟中断/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root); t.after(() => rm(root, { recursive: true, force: true }))
  const taskFile = (await readdir(join(root, 'task', 'tasks')))[0]!
  const script = `
    const { LlmAdapter } = require('@fly-novel/llm');
    const configured = require('./.test-dist/app/call-llm.js'); let calls = 0;
    class Fake extends LlmAdapter {
      constructor(discussion) { super(); this.discussion = discussion; this.step = 0 }
      async *stream() {
        if (this.step++ === 0) {
          const name = this.discussion ? 'discussion_prepare' : 'save_first_world_plan';
          const args = this.discussion ? {content:'城门夜间关闭，紧急医疗运输可以申请通行。',summary:'修改城门'} : {content:'曲水城夜间关闭城门。'};
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixed',name,arguments:JSON.stringify(args)}};
          yield {type:'finish',reason:{kind:'tool-calls'}};
        } else { yield {type:'block-end',index:0,block:{type:'text',text:'已保存'}}; yield {type:'finish',reason:{kind:'stop'}}; }
      }
    }
    configured.loadConfiguredAdapter = async provider => ({provider,model:'fixed',adapter:new Fake(calls++ >= 2)});
    const {runWorldInitializationFullExample,sampleInput} = require('./.test-dist/app/world-initialization-full-example.js');
    runWorldInitializationFullExample(sampleInput,()=>{}, {resumeRoot:process.argv[1]}).then(result=>process.stdout.write(JSON.stringify({taskId:result.taskId,deliveryId:result.deliveryId}))).catch(error=>{process.stderr.write(String(error));process.exitCode=1});`
  const childResult = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; let error = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += String(chunk) })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += String(chunk) })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', cause => { clearTimeout(timer); reject(cause) })
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output: text, error }) })
  })
  assert.equal(childResult.code, 0, childResult.error)
  const result: unknown = JSON.parse(childResult.output)
  assert.ok(result && typeof result === 'object' && 'taskId' in result && result.taskId === taskFile.slice(0, -5))
  assert.equal((await readdir(join(root, 'delivery', 'deliveries'))).length, 1)
})
