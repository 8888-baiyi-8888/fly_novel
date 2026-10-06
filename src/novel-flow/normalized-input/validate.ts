/** N0 整理输出不符合契约时抛出。 */
export class RawInputValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RawInputValidationError";
  }
}

/**
 * 解析并校验 N0 单次输出（{ rawInput }）：rawInput 必须是非空字符串，返回整理文本。
 */
export function parseRawInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RawInputValidationError("N0 整理输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.rawInput !== "string" || obj.rawInput.trim().length === 0) {
    throw new RawInputValidationError("字段 rawInput 必须是文本且不能为空字符串");
  }
  return obj.rawInput;
}
