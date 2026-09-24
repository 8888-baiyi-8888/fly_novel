import { HookSeed, HookTiming, State0 } from "./types";

/** 输出不符合协议时抛出。 */
export class State0ValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "State0ValidationError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new State0ValidationError(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new State0ValidationError(`字段 ${field} 必须是数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new State0ValidationError(`字段 ${field}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

const TIMING_VALUES: readonly string[] = ["immediate", "near-term", "mid-arc", "slow-burn", "endgame"];

/** 平台伏笔档位配比（v2 文档 13.1：immediate 10% / near-term 30% / mid-arc 35% / slow-burn 20% / endgame 5%）。 */
export const TIMING_MIX: Record<HookTiming, number> = {
  immediate: 0.1,
  "near-term": 0.3,
  "mid-arc": 0.35,
  "slow-burn": 0.2,
  endgame: 0.05,
};

/** 最大活跃伏笔数（同时 open 的种子数上限）。 */
export const MAX_ACTIVE_HOOKS = 12;

/** 档位配比偏差阈值（N6 种子登记，> ±10 个百分点给 warning）。 */
export const TIMING_MIX_TOLERANCE = 0.1;

/** 解析并校验 State₀。lines 为 N5 叙事线地图的线 ID 集合（用于校验 threadBoard 引用）。 */
export function parseState0Output(input: unknown, lineIds: string[]): State0 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new State0ValidationError("State₀ 输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;

  const charactersRaw = obj.characterStates;
  if (!Array.isArray(charactersRaw) || charactersRaw.length === 0) {
    throw new State0ValidationError("字段 characterStates 必须是非空数组");
  }
  const characterStates = charactersRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new State0ValidationError(`字段 characterStates[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    return {
      name: requireNonEmptyString(o.name, `characterStates[${index}].name`),
      location: requireNonEmptyString(o.location, `characterStates[${index}].location`),
      identity: requireNonEmptyString(o.identity, `characterStates[${index}].identity`),
      emotion: requireNonEmptyString(o.emotion, `characterStates[${index}].emotion`),
      cognition: requireNonEmptyString(o.cognition, `characterStates[${index}].cognition`),
      resources: requireNonEmptyString(o.resources, `characterStates[${index}].resources`),
    };
  });

  const relationsRaw = obj.relationshipStates;
  if (!Array.isArray(relationsRaw) || relationsRaw.length === 0) {
    throw new State0ValidationError("字段 relationshipStates 必须是非空数组");
  }
  const relationshipStates = relationsRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new State0ValidationError(`字段 relationshipStates[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    const subjects = requireStringArray(o.subjects, `relationshipStates[${index}].subjects`);
    if (subjects.length < 2) {
      throw new State0ValidationError(`字段 relationshipStates[${index}].subjects 至少要有两个人`);
    }
    return {
      subjects,
      relation: requireNonEmptyString(o.relation, `relationshipStates[${index}].relation`),
      trust: requireNonEmptyString(o.trust, `relationshipStates[${index}].trust`),
      knowledge: requireNonEmptyString(o.knowledge, `relationshipStates[${index}].knowledge`),
    };
  });

  const worldRaw = obj.worldState;
  if (!Array.isArray(worldRaw) || worldRaw.length === 0) {
    throw new State0ValidationError("字段 worldState 必须是非空数组");
  }
  const worldState = worldRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new State0ValidationError(`字段 worldState[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    return {
      key: requireNonEmptyString(o.key, `worldState[${index}].key`),
      value: requireNonEmptyString(o.value, `worldState[${index}].value`),
    };
  });

  const seedsRaw = obj.hookSeeds;
  if (!Array.isArray(seedsRaw)) {
    throw new State0ValidationError("字段 hookSeeds 必须是数组");
  }
  const hookSeeds: HookSeed[] = seedsRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new State0ValidationError(`字段 hookSeeds[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.plantedChapter !== "number" || !Number.isInteger(o.plantedChapter) || o.plantedChapter <= 0) {
      throw new State0ValidationError(`字段 hookSeeds[${index}].plantedChapter 必须是正整数`);
    }
    const timing = requireNonEmptyString(o.timing, `hookSeeds[${index}].timing`);
    if (!TIMING_VALUES.includes(timing)) {
      throw new State0ValidationError(`字段 hookSeeds[${index}].timing 只能是 ${TIMING_VALUES.join("/")}，收到：${timing}`);
    }
    const expectedPayoff =
      o.expectedPayoff === null || o.expectedPayoff === undefined
        ? null
        : (() => {
            if (typeof o.expectedPayoff !== "number" || !Number.isInteger(o.expectedPayoff) || o.expectedPayoff <= 0) {
              throw new State0ValidationError(`字段 hookSeeds[${index}].expectedPayoff 必须是正整数或 null`);
            }
            return o.expectedPayoff;
          })();
    const notes = typeof o.notes === "string" ? o.notes.trim() : "";
    const payoffNote = typeof o.payoffNote === "string" ? o.payoffNote.trim() : "";
    // 准入硬规则 1：type 非空
    const type = requireNonEmptyString(o.type, `hookSeeds[${index}].type`);
    // 准入硬规则 2：expectedPayoff 或 notes 至少一个非空（写不出怎么还 → 拒绝入账）
    if (expectedPayoff === null && notes.length === 0 && payoffNote.length === 0) {
      throw new State0ValidationError(`hookSeeds[${index}]（${type}）写不出打算怎么还（expectedPayoff 与 notes 均为空）→ 拒绝入账`);
    }
    return {
      hookId: requireNonEmptyString(o.hookId, `hookSeeds[${index}].hookId`),
      beatTag: requireNonEmptyString(o.beatTag, `hookSeeds[${index}].beatTag`),
      plantedChapter: o.plantedChapter,
      type,
      timing: timing as HookTiming,
      core: typeof o.core === "string" ? o.core.trim() : "",
      expectedPayoff,
      payoffNote,
      notes,
    };
  });

  const boardRaw = obj.threadBoard;
  if (!Array.isArray(boardRaw) || boardRaw.length === 0) {
    throw new State0ValidationError("字段 threadBoard 必须是非空数组");
  }
  const threadBoard = boardRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new State0ValidationError(`字段 threadBoard[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    const lineId = requireNonEmptyString(o.lineId, `threadBoard[${index}].lineId`);
    if (!lineIds.includes(lineId)) {
      throw new State0ValidationError(`字段 threadBoard[${index}].lineId（${lineId}）不存在于叙事线地图`);
    }
    const currentEvent = o.currentEvent === null || o.currentEvent === undefined ? null : requireNonEmptyString(o.currentEvent, `threadBoard[${index}].currentEvent`);
    return {
      lineId,
      status: requireNonEmptyString(o.status, `threadBoard[${index}].status`),
      currentEvent,
      nextEvent:
        o.nextEvent === null || o.nextEvent === undefined ? null : requireNonEmptyString(o.nextEvent, `threadBoard[${index}].nextEvent`),
      waitingFor: requireStringArray(o.waitingFor, `threadBoard[${index}].waitingFor`),
      estimatedWake: requireNonEmptyString(o.estimatedWake, `threadBoard[${index}].estimatedWake`),
    };
  });

  const progressRaw = obj.progressState;
  if (typeof progressRaw !== "object" || progressRaw === null || Array.isArray(progressRaw)) {
    throw new State0ValidationError("字段 progressState 必须是对象");
  }
  const p = progressRaw as Record<string, unknown>;
  if (p.currentChapter !== 0) {
    throw new State0ValidationError("字段 progressState.currentChapter 必须为 0（故事尚未开始）");
  }
  const progressState = {
    currentChapter: 0,
    currentVolume: requireNonEmptyString(p.currentVolume, "progressState.currentVolume"),
    stage: requireNonEmptyString(p.stage, "progressState.stage"),
    completedEvents: requireStringArray(p.completedEvents, "progressState.completedEvents"),
    nextDirection: requireNonEmptyString(p.nextDirection, "progressState.nextDirection"),
  };

  return {
    bookId: "",
    title: "",
    characterStates,
    relationshipStates,
    worldState,
    hookSeeds,
    threadBoard,
    progressState,
  };
}

/** 校验伏笔种子登记（N6 硬规则 + warning），返回违规列表。 */
export function validateHookSeeds(seeds: HookSeed[]): string[] {
  const violations: string[] = [];
  // 最大活跃：登记后 activeCount = 种子总数 ≤ 12
  if (seeds.length > MAX_ACTIVE_HOOKS) {
    violations.push(`伏笔种子数 ${seeds.length} 超过最大活跃 ${MAX_ACTIVE_HOOKS}（超出的应降级/延后到后续卷再开）`);
  }
  // 档位配比：五档分布 vs 10/30/35/20/5，偏差 > ±10 个百分点 → warning
  if (seeds.length > 0) {
    const counts: Record<string, number> = { immediate: 0, "near-term": 0, "mid-arc": 0, "slow-burn": 0, endgame: 0 };
    for (const seed of seeds) {
      counts[seed.timing] = (counts[seed.timing] ?? 0) + 1;
    }
    for (const [timing, ratio] of Object.entries(TIMING_MIX)) {
      const actual = counts[timing] / seeds.length;
      if (Math.abs(actual - ratio) > TIMING_MIX_TOLERANCE) {
        violations.push(
          `[warning] 档位 ${timing} 占比 ${(actual * 100).toFixed(0)}% 偏离配置 ${(ratio * 100).toFixed(0)}%（偏差 >±10 个百分点，建议调整种子档位）`,
        );
      }
    }
  }
  return violations;
}

/** 从节拍板收集 hook tag 的埋设章与回收章。beats 为 N5 节拍板（每章 hookIntentions 带 【chN-hX】 前缀 tag，plannedPayoffOf 为 tag 数组）。 */
function collectBeatHookTags(beats: { chapter: number; hookIntentions: string[]; plannedPayoffOf: string[] }[]): {
  planted: Map<string, number>;
  payoff: Map<string, number>;
} {
  const planted = new Map<string, number>();
  const payoff = new Map<string, number>();
  const TAG_RE = /【(ch\d+-h\d+)】/;
  for (const beat of beats) {
    for (const intention of beat.hookIntentions) {
      const match = TAG_RE.exec(intention);
      if (match !== null) {
        const tag = match[1];
        if (!planted.has(tag)) {
          planted.set(tag, beat.chapter);
        }
      }
    }
    for (const tag of beat.plannedPayoffOf) {
      const trimmed = tag.trim();
      if (trimmed.length > 0 && !payoff.has(trimmed)) {
        payoff.set(trimmed, beat.chapter);
      }
    }
  }
  return { planted, payoff };
}

/**
 * 伏笔种子 ↔ 节拍板对账（硬规则）：每条种子必须能在节拍板里找到对应 hookIntention，
 * 且该 tag 后面有 plannedPayoffOf 回收（回收章 > 埋设章）——"得在后面能回收才能入账"。
 * 只埋不收 / 凭空编造的种子 → 拒绝入账。
 */
export function validateHookSeedsAgainstBeatBoard(
  seeds: HookSeed[],
  beats: { chapter: number; hookIntentions: string[]; plannedPayoffOf: string[] }[],
): string[] {
  const violations: string[] = [];
  const { planted, payoff } = collectBeatHookTags(beats);
  for (const seed of seeds) {
    const tag = seed.beatTag.trim();
    const plantedChapter = planted.get(tag);
    const payoffChapter = payoff.get(tag);
    if (plantedChapter === undefined) {
      violations.push(`种子 ${seed.hookId} 的 beatTag（${tag}）在节拍板里找不到对应 hookIntention → 凭空编造，拒绝入账`);
      continue;
    }
    if (payoffChapter === undefined) {
      violations.push(`种子 ${seed.hookId} 的 beatTag（${tag}）只埋不收：节拍板里没有 plannedPayoffOf 引用它 → 拒绝入账`);
      continue;
    }
    if (payoffChapter <= plantedChapter) {
      violations.push(`种子 ${seed.hookId} 的 beatTag（${tag}）回收章 ${payoffChapter} 不在埋设章 ${plantedChapter} 之后 → 拒绝入账`);
    }
  }
  return violations;
}
