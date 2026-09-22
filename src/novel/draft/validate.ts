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

/**
 * 原版：空字符串会被当作非法值，导致模型输出 ""（未填写的可选字段）时整份草案被拒。
 * 保留注释，便于回切。
 */
// function optionalString(value: unknown, field: string): string | undefined {
//   if (value === undefined) {
//     return undefined;
//   }
//   return requireString(value, field);
// }

/** 可选字符串：undefined 或空字符串都视为「未填写」，返回 undefined。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || (typeof value === "string" && value.length === 0)) {
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

/**
 * 原版：只解析单个主角（返回 undefined 表示缺省）。
 * 保留注释，便于回切。v2 起主角是多主角数组，见 parseProtagonists。
 */
// function parseProtagonist(value: unknown): ProtagonistDraft | undefined {
//   if (value === undefined) {
//     return undefined;
//   }
//   if (typeof value !== "object" || value === null || Array.isArray(value)) {
//     throw new DraftValidationError("字段 protagonist 必须是对象");
//   }
//   const obj = value as Record<string, unknown>;
//   return {
//     name: requireString(obj.name, "protagonist.name"),
//     age: optionalNumber(obj.age, "protagonist.age"),
//     identity: optionalString(obj.identity, "protagonist.identity"),
//     traits: optionalStringArray(obj.traits, "protagonist.traits"),
//     coreNeed: optionalString(obj.coreNeed, "protagonist.coreNeed"),
//     coreFear: optionalString(obj.coreFear, "protagonist.coreFear"),
//   };
// }

/** 解析单个主角对象（必填版）：value 必须是对象，name 必填；prefix 用于错误信息定位。 */
function parseProtagonistObject(value: unknown, prefix: string): ProtagonistDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftValidationError(`字段 ${prefix} 必须是对象`);
  }
  const obj = value as Record<string, unknown>;
  return {
    name: requireString(obj.name, `${prefix}.name`),
    age: optionalNumber(obj.age, `${prefix}.age`),
    identity: optionalString(obj.identity, `${prefix}.identity`),
    traits: optionalStringArray(obj.traits, `${prefix}.traits`),
    coreNeed: optionalString(obj.coreNeed, `${prefix}.coreNeed`),
    coreFear: optionalString(obj.coreFear, `${prefix}.coreFear`),
  };
}

/** 解析主角数组（v2）：每项必须是对象、name 必填；undefined 或缺省视为未填写。 */
function parseProtagonists(value: unknown): ProtagonistDraft[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new DraftValidationError("字段 protagonists 必须是数组");
  }
  return value.map((item, index) => parseProtagonistObject(item, `protagonists[${index}]`));
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
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) {
    throw new DraftValidationError(`不支持的草案版本：${String(obj.schemaVersion)}（支持 1 和 2）`);
  }

  // 主角解析：
  // - v2：优先读 protagonists（复数）；若模型仍按旧名输出 protagonist（单数）数组，兜底迁移。
  // - v1 迁移：单数 protagonist 对象并入数组；若 v1 误给数组，也按数组解析。
  const protagonists =
    obj.schemaVersion === 1
      ? obj.protagonist !== undefined
        ? Array.isArray(obj.protagonist)
          ? parseProtagonists(obj.protagonist)
          : [parseProtagonistObject(obj.protagonist, "protagonist")]
        : undefined
      : parseProtagonists(
          obj.protagonists ?? (Array.isArray(obj.protagonist) ? obj.protagonist : undefined),
        );

  return {
    schemaVersion: 2,
    title: optionalString(obj.title, "title"),
    genre: requireStringArray(obj.genre, "genre"),
    protagonists,
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


/** 澄清轮解析结果：questions 是需要用户回答的问题；draft 存在即表示模型已给出完整草案。 */
export interface ClarificationTurn {
  /** 待用户回答的问题；为空数组表示无需再问。 */
  questions: string[];
  /** 模型给出的完整草案（协议要求与 questions 互斥：有问题时 draft 为 null）。 */
  draft?: CreativeDraft;
}

/**
 * 解析并校验澄清轮输出（{ questions, draft } 包装结构）。
 * - questions 必须是字符串数组（允许空）；
 * - draft 为 null / 缺失时按"提问轮"处理，draft 为对象时按完整草案校验；
 * - 若模型同时给出问题与草案（违规），仍接受草案并把问题留给调用方决定是否并入。
 */
export function parseClarificationTurn(input: unknown): ClarificationTurn {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DraftValidationError("澄清轮输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) {
    throw new DraftValidationError("字段 questions 必须是数组");
  }
  if (!obj.questions.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new DraftValidationError("字段 questions 的每项必须是非空字符串");
  }
  const questions: string[] = obj.questions.map((item) => (item as string).trim());
  const draft =
    obj.draft === null || obj.draft === undefined ? undefined : parseAndValidateDraft(obj.draft);
  return { questions, ...(draft === undefined ? {} : { draft }) };
}
