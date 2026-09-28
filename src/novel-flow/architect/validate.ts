import { StoryBibleSection } from "./types";

/** 架构师输出不符合契约时抛出。 */
export class ArchitectValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchitectValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireNonEmptyStringArray(
  value: unknown,
  field: string,
): { title: string; content: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArchitectValidationError(`字段 ${field} 必须是非空数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ArchitectValidationError(`字段 ${field}[${index}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    return {
      title: obj.title === undefined ? "" : String(obj.title),
      content: obj.content === undefined ? "" : String(obj.content),
    };
  });
}

function requireContentArray(value: unknown, field: string): { content: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArchitectValidationError(`字段 ${field} 必须是非空数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ArchitectValidationError(`字段 ${field}[${index}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    return { content: obj.content === undefined ? "" : String(obj.content) };
  });
}

/**
 * 解析并校验架构师输出（{ storyBible, bookRules }）：
 * - storyBible 非空数组，每项 title/content 非空；
 * - bookRules 非空数组，每项 content 非空。
 * 返回规范化后的结构（id 由调用方生成）。
 */
export function parseArchitectOutput(input: unknown): {
  storyBible: StoryBibleSection[];
  bookRules: { content: string }[];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArchitectValidationError("架构师输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;

  const sections = requireNonEmptyStringArray(obj.storyBible, "storyBible");
  const storyBible: StoryBibleSection[] = sections.map((section, index) => {
    if (!isNonEmptyString(section.title)) {
      throw new ArchitectValidationError(`字段 storyBible[${index}].title 必须是非空字符串`);
    }
    if (!isNonEmptyString(section.content)) {
      throw new ArchitectValidationError(`字段 storyBible[${index}].content 必须是非空字符串`);
    }
    return {
      id: `S${String(index + 1).padStart(2, "0")}`,
      title: section.title.trim(),
      content: section.content.trim(),
    };
  });

  const rules = requireContentArray(obj.bookRules, "bookRules");
  const bookRules = rules.map((rule, index) => {
    if (!isNonEmptyString(rule.content)) {
      throw new ArchitectValidationError(`字段 bookRules[${index}].content 必须是非空字符串`);
    }
    return { content: rule.content.trim() };
  });

  return { storyBible, bookRules };
}
