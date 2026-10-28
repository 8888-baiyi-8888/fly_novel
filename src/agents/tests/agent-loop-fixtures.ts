import { LlmAdapter } from '@fly-novel/llm'
import type { GenerateOptions, StreamChunk } from '@fly-novel/llm'
import type { AgentFramework, CreateAgentOptions, AgentPreset } from '../core/index.js'

const provider = 'test-provider'
const model = 'test-model'

export class EchoLlmAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = options.messages.at(-1)?.content[0]
    const text = input?.type === 'text' ? input.text : ''
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function withAgentLoop(plugins: AgentPreset['plugins']): AgentPreset['plugins'] {
  return [
    { pluginId: 'agent-loop-runtime', config: { provider, model } },
    { pluginId: 'system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    ...plugins.filter(({ pluginId }) => ![
      'agent-loop-runtime', 'system-prompt', 'llm', 'session',
    ].includes(pluginId)),
  ]
}

export function withTestModel(options: CreateAgentOptions): CreateAgentOptions {
  return {
    ...options,
    pluginConfigs: {
      'agent-loop-runtime': { provider, model },
      llm: { adapters: [{ providers: [provider], adapter: new EchoLlmAdapter() }] },
      ...options.pluginConfigs,
    },
  }
}

export function createTestAgent(framework: AgentFramework, options: CreateAgentOptions) {
  return framework.manager.create(withTestModel(options))
}
