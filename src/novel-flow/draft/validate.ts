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

/** 从值中提取数字：数字直接返回；字符串提取首个数字序列（如 "22岁"→22、"100章左右"→100）。 */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const match = /[-+]?\d+(\.\d+)?/.exec(value.trim());
    if (match !== null) {
      const n = Number(match[0]);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  return undefined;
}

// 原逻辑（仅接受数字，模型给 "22岁" / "100章左右" 等带单位字符串会报错）：
//   function optionalNumber(value, field) {
//     if (value === undefined) return undefined;
//     if (typeof value !== "number" || !Number.isFinite(value)) throw ...必须是数字;
//     return value;
//   }
/** 可选数字：缺失返回 undefined；字符串宽容提取数字序列（兼容模型带单位写法）。 */
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = coerceNumber(value);
  if (n === undefined) {
    throw new DraftValidationError(`字段 ${field} 必须是数字`);
  }
  return n;
}

/** 必填数字：缺失或无法提取数字都报错（N1 输出契约要求平台篇幅必填）。 */
function requireNumber(value: unknown, field: string): number {
  const n = optionalNumber(value, field);
  if (n === undefined) {
    throw new DraftValidationError(`字段 ${field} 必须是数字`);
  }
  return n;
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

/**
 * 解析主角数组（v2 必填版）：必须是数组且至少一项，每项 name 必填；
 * 缺失或空数组直接报错（N1 输出契约要求主角必填）。
 */
function parseProtagonists(value: unknown): ProtagonistDraft[] {
  if (value === undefined) {
    throw new DraftValidationError("字段 protagonists 必须是数组且至少一项");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new DraftValidationError("字段 protagonists 必须是数组且至少一项");
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
        : parseProtagonists(undefined)
      : parseProtagonists(
          obj.protagonists ?? (Array.isArray(obj.protagonist) ? obj.protagonist : undefined),
        );

  return {
    schemaVersion: 2,
    title: requireString(obj.title, "title"),
    genre: requireStringArray(obj.genre, "genre"),
    protagonists,
    supportingCast: parseSupportingCast(obj.supportingCast),
    worldPremise: requireString(obj.worldPremise, "worldPremise"),
    setting: optionalStringArray(obj.setting, "setting"),
    coreConflict: requireString(obj.coreConflict, "coreConflict"),
    blurb: optionalString(obj.blurb, "blurb"),
    authorIntent: requireString(obj.authorIntent, "authorIntent"),
    tone: requireStringArray(obj.tone, "tone"),
    volumePlan: requireStringArray(obj.volumePlan, "volumePlan"),
    currentFocus: optionalStringArray(obj.currentFocus, "currentFocus"),
    constraints: requireStringArray(obj.constraints, "constraints"),
    platform: requireString(obj.platform, "platform"),
    targetChapters: requireNumber(obj.targetChapters, "targetChapters"),
    chapterWordCount: requireNumber(obj.chapterWordCount, "chapterWordCount"),
    language: requireString(obj.language, "language"),
    openQuestions: optionalStringArray(obj.openQuestions, "openQuestions") ?? [],
    rawSummary: requireString(obj.rawSummary, "rawSummary"),
  };
}


/**
 * 程序兜底：对模型给的部分草案补全必填字段（volumePlan 等），返回能通过 parseAndValidateDraft 的完整草案。
 * 仅用于澄清流程模型反复漏填必填字段时保底；内容为合理占位，后续 N3/N4/N5 会真正细化卷规划等。
 */
export function patchDraftCompleteness(partial: Record<string, unknown>): CreativeDraft {
  const obj = { ...partial };
  const chapters = typeof obj.targetChapters === "number" && obj.targetChapters > 0 ? obj.targetChapters : 100;
  const volCount = 3;
  const per = Math.max(1, Math.floor(chapters / volCount));
  const labels = ["开局与铺垫", "冲突与升级", "高潮与收束"];
  const ordinals = ["一", "二", "三"];
  const volPlan = Array.from({ length: volCount }, (_, i) => {
    const start = i * per + 1;
    const end = i === volCount - 1 ? chapters : (i + 1) * per;
    return `第${ordinals[i]}卷（ch${start}-ch${end}）：${labels[i]}`;
  });
  obj.volumePlan = Array.isArray(obj.volumePlan) && obj.volumePlan.length > 0 ? obj.volumePlan : volPlan;
  obj.genre = Array.isArray(obj.genre) && obj.genre.length > 0 ? obj.genre : ["都市"];
  obj.tone = Array.isArray(obj.tone) && obj.tone.length > 0 ? obj.tone : ["节奏明快"];
  obj.constraints = Array.isArray(obj.constraints) && obj.constraints.length > 0 ? obj.constraints : ["不狗血"];
  if (typeof obj.setting === "undefined" || !Array.isArray(obj.setting) || obj.setting.length === 0) {
    obj.setting = ["待补充设定"];
  }
  if (!obj.title || typeof obj.title !== "string" || !obj.title.trim()) obj.title = "未命名小说";
  if (!obj.worldPremise || typeof obj.worldPremise !== "string" || !obj.worldPremise.trim()) obj.worldPremise = "（世界观待 N3 细化）";
  if (!obj.coreConflict || typeof obj.coreConflict !== "string" || !obj.coreConflict.trim()) obj.coreConflict = "（核心冲突待细化）";
  if (!obj.blurb || typeof obj.blurb !== "string" || !obj.blurb.trim()) obj.blurb = "（简介待细化）";
  if (!obj.authorIntent || typeof obj.authorIntent !== "string" || !obj.authorIntent.trim()) obj.authorIntent = "（作者意图待细化）";
  if (!obj.platform || typeof obj.platform !== "string" || !obj.platform.trim()) obj.platform = "番茄";
  if (typeof obj.targetChapters !== "number" || obj.targetChapters <= 0) obj.targetChapters = 100;
  if (typeof obj.chapterWordCount !== "number" || obj.chapterWordCount <= 0) obj.chapterWordCount = 2500;
  if (typeof obj.language !== "string" || !obj.language.trim()) obj.language = "zh";
  if (!Array.isArray(obj.protagonists) || obj.protagonists.length === 0) {
    obj.protagonists = [{ name: "主角" }];
  if (!Array.isArray(obj.supportingCast) || obj.supportingCast.length < 2) {
    obj.supportingCast = [
      { name: "配角甲", identity: "配角，定位待 N3 细化", relation: "与主角相关" },
      { name: "配角乙", identity: "配角，定位待 N3 细化", relation: "与主角相关" },
    ];
  }
  }
  return parseAndValidateDraft(obj);
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
 * - questions 容错：模型在「更新草案」轮经常省略该字段 → 缺失/null 视为空数组；
 *   字符串视为单个问题；数组过滤掉空项/非字符串项；其他类型才报错。
 * - draft 为 null / 缺失时按"提问轮"处理，draft 为对象时按完整草案校验；
 * - 若模型同时给出问题与草案（违规），仍接受草案并把问题留给调用方决定是否并入。
 */
export function parseClarificationTurn(input: unknown): ClarificationTurn {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DraftValidationError("澄清轮输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  let questions: string[];
  if (obj.questions === undefined || obj.questions === null) {
    questions = [];
  } else if (typeof obj.questions === "string") {
    const text = obj.questions.trim();
    questions = text.length > 0 ? [text] : [];
  } else if (Array.isArray(obj.questions)) {
    questions = (obj.questions as unknown[])
      .filter((item) => typeof item === "string" && item.trim().length > 0)
      .map((item) => (item as string).trim());
  } else {
    throw new DraftValidationError("字段 questions 必须是数组、字符串或省略");
  }
  // 原逻辑（无论中间/最终都强校验 draft，半成品会抛错中断澄清）：
  //   const draft = obj.draft === null || obj.draft === undefined ? undefined : parseAndValidateDraft(obj.draft);
  // 修复：draft 一律宽容解析（不做必填强校验）。模型在澄清中段常给「半成品 draft + 问题」
  // （协议要求 draft 为 null，但模型不严格遵循），半成品若强校验会因缺 volumePlan 等卡死澄清。
  // 完整草案才保留（供最后一轮交卷，此时模型常同时给「完整草案 + 残留问题」）；半成品丢弃为
  // undefined（视为尚无草案），保留 questions：中间轮走提问，最终轮交给 finalizeDraft 兜底交卷。
  let draft;
  if (obj.draft !== null && obj.draft !== undefined) {
    try {
      draft = parseAndValidateDraft(obj.draft);
    } catch {
      draft = undefined;
    }
  }
  return { questions, ...(draft === undefined ? {} : { draft }) };
}
