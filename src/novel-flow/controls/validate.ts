import { VolumeDirection } from "./types";

/** 长期创作控制输出不符合契约时抛出。 */
export class ControlsValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlsValidationError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlsValidationError(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlsValidationError(`字段 ${field} 必须是非空数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ControlsValidationError(`字段 ${field}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/**
 * 解析并校验长期创作控制输出（{ authorIntent, currentFocus, volumeDirections, constraints }）。
 * 返回规范化后的结构；id 与 bookId 由调用方生成。
 */
export function parseControlsOutput(input: unknown): {
  authorIntent: string;
  currentFocus: string[];
  volumeDirections: VolumeDirection[];
  constraints: string[];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ControlsValidationError("长期创作控制输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;

  const volumeDirections = obj.volumeDirections;
  if (!Array.isArray(volumeDirections) || volumeDirections.length === 0) {
    throw new ControlsValidationError("字段 volumeDirections 必须是非空数组");
  }
  const directions: VolumeDirection[] = volumeDirections.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ControlsValidationError(`字段 volumeDirections[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    return {
      volume: requireNonEmptyString(o.volume, `volumeDirections[${index}].volume`),
      direction: requireNonEmptyString(o.direction, `volumeDirections[${index}].direction`),
    };
  });

  return {
    authorIntent: requireNonEmptyString(obj.authorIntent, "authorIntent"),
    currentFocus: requireStringArray(obj.currentFocus, "currentFocus"),
    volumeDirections: directions,
    constraints: requireStringArray(obj.constraints, "constraints"),
  };
}
