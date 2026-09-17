import { callConfiguredLlm } from '../../app/call-llm';
import type { MessageId } from '../brand';

/** 手动连通性测试，复用应用的配置读取与凭据解密流程。 */
async function main(): Promise<void> {
  console.log('正在使用已有配置请求 DeepSeek…（Ctrl+C 可退出）');
  const text = await callConfiguredLlm({ provider: "deepseek",
    messages: [{ id: 'manual-test' as MessageId, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '今天重庆天气如何' }] }],
  });
  console.log('请求完成：' + (text ?? '[没有文本回复]'));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '测试失败');
  process.exitCode = 1;
});
