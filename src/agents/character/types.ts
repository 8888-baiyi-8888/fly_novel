import type { BaseLanguageModel } from "@langchain/core/language_models/base";

export const DEFAULT_BRANCH_ID = "main"

export type CharacterInfos = string | Record<string, unknown>;

export interface CharacterAgentOptions {
  /** 应用创建的模型实例，包含模型选择及 API 凭据配置。 */
  model: BaseLanguageModel;

  /** 小说唯一标识。 */
  novelId: string;

  /** 角色唯一标识。 */
  characterId: string;

  /** 分支唯一标识，用于场景重演；未提供时默认使用 {@link DEFAULT_BRANCH_ID}。 */
  branchId?: string;

  /** 角色信息，可为文本描述或结构化对象。 */
  characterInfos?: CharacterInfos;
}
