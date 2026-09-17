import { DeepSeekAdapter } from '../llm/deepseek';
import type { LlmAdapter } from '../llm/adapter';

interface AdapterConnection {
  readonly baseURL: string;
  readonly apiKey: string;
}

/** 工厂只负责供应商专有选项与实例创建；公共配置和解密由应用入口处理。 */
type AdapterFactory = (connection: AdapterConnection, config: object) => LlmAdapter;

const factories: Readonly<Record<string, AdapterFactory>> = {
  deepseek(connection, config) {
    const thinking = 'thinking' in config ? config.thinking : undefined;
    if (thinking !== undefined && thinking !== 'enabled' && thinking !== 'disabled') {
      throw new Error('deepseek.thinking 必须为 enabled 或 disabled');
    }
    return new DeepSeekAdapter({ ...connection, thinking });
  },
};

/** 根据供应商标识取得工厂；未注册时立即失败，不读取或解密凭据。 */
export function getAdapterFactory(provider: string): AdapterFactory {
  if (!provider || !Object.hasOwn(factories, provider)) {
    throw new Error(`未注册供应商适配器：${provider}`);
  }
  return factories[provider];
}
