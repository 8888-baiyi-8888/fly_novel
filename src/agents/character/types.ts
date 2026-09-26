import type { z } from "zod";

/** 创建时固定的模型选择及角色定位。 */
export interface CharacterAgentOptions {
  readonly modelId?: string;
  readonly storyId: string;
  /** 省略时使用 main。 */
  readonly branchId?: string;
  readonly characterId: string;
}
/** 外部提供的角色可知场景，具体字段结构尚待定义。 */
export type CharacterScene = Readonly<Record<string, unknown>>;
export interface CharacterAgentRunInput<TSchema extends z.ZodObject = z.ZodObject> {
  readonly scene: CharacterScene;
  /** 调用方定义的 Zod 对象 Schema，决定字段、类型、描述和额外字段策略。 */
  readonly responseFormat: TSchema;
}
export interface CharacterAgentRunOptions {
  readonly signal?: AbortSignal;
}
/** 上下文准备方法的统一结果；空白表示没有内容。 */
export interface CharacterContextSection {
  readonly content: string;
}
