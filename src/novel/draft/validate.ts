import { CreativeDraft, ProtagonistDraft, SupportingCastDraft } from "./types";

/** 草案不符合契约时抛出。 */
export class DraftValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DraftValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new DraftValidationError(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!isNonEmptyStringArray(value)) {
    throw new DraftValidationError(`字段 ${field} 必须是非空字符串数组`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isStringArray(value)) {
    throw new DraftValidationError(`字段 ${field} 必须是字符串数组`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DraftValidationError(`字段 ${field} 必须是数字`);
  }
  return value;
}

function parseProtagonist(value: unknown): ProtagonistDraft | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftValidationError("字段 protagonist 必须是对象");
  }
  const obj = value as Record<string, unknown>;
  return {
    name: requireString(obj.name, "protagonist.name"),
    age: optionalNumber(obj.age, "protagonist.age"),
    identity: optionalString(obj.identity, "protagonist.identity"),
    traits: optionalStringArray(obj.traits, "protagonist.traits"),
    coreNeed: optionalString(obj.coreNeed, "protagonist.coreNeed"),
    coreFear: optionalString(obj.coreFear, "protagonist.coreFear"),
  };
}

/** 校验配角数组：name 必填，identity/traits/relation 可选；返回规范化后的数组。 */
function parseSupportingCast(value: unknown): SupportingCastDraft[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new DraftValidationError("字段 supportingCast 必须是数组");
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DraftValidationError(`字段 supportingCast[${index}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    return {
      name: requireString(obj.name, `supportingCast[${index}].name`),
      identity: optionalString(obj.identity, `supportingCast[${index}].identity`),
      traits: optionalStringArray(obj.traits, `supportingCast[${index}].traits`),
      relation: optionalString(obj.relation, `supportingCast[${index}].relation`),
    };
  });
}

/** 校验解析后的对象是否符合 CreativeDraft，返回规范化后的草案；不合法抛 DraftValidationError。 */
export function parseAndValidateDraft(input: unknown): CreativeDraft {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DraftValidationError("草案必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new DraftValidationError(`不支持的草案版本：${String(obj.schemaVersion)}`);
  }
  return {
    schemaVersion: 1,
    title: optionalString(obj.title, "title"),
    genre: requireStringArray(obj.genre, "genre"),
    protagonist: parseProtagonist(obj.protagonist),
    supportingCast: parseSupportingCast(obj.supportingCast),
    worldPremise: optionalString(obj.worldPremise, "worldPremise"),
    setting: optionalStringArray(obj.setting, "setting"),
    coreConflict: optionalString(obj.coreConflict, "coreConflict"),
    blurb: optionalString(obj.blurb, "blurb"),
    authorIntent: optionalString(obj.authorIntent, "authorIntent"),
    tone: requireStringArray(obj.tone, "tone"),
    volumePlan: optionalStringArray(obj.volumePlan, "volumePlan"),
    currentFocus: optionalStringArray(obj.currentFocus, "currentFocus"),
    constraints: optionalStringArray(obj.constraints, "constraints"),
    platform: optionalString(obj.platform, "platform"),
    targetChapters: optionalNumber(obj.targetChapters, "targetChapters"),
    chapterWordCount: optionalNumber(obj.chapterWordCount, "chapterWordCount"),
    language: optionalString(obj.language, "language"),
    openQuestions: optionalStringArray(obj.openQuestions, "openQuestions") ?? [],
    rawSummary: requireString(obj.rawSummary, "rawSummary"),
  };
}
