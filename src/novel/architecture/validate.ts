import {
  ArchitectureParts,
  Beat,
  BeatBoard,
  CharacterCard,
  Pacing,
  StoryFrame,
  ThreadEvent,
  ThreadLine,
  ThreadMap,
  Tier,
  VolumeMapItem,
} from "./types";

/** 输出不符合协议时抛出。 */
export class ArchitectureValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchitectureValidationError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArchitectureValidationError(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArchitectureValidationError(`字段 ${field} 必须是非空数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ArchitectureValidationError(`字段 ${field}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/** 允许空数组的字符串数组校验（每项仍须非空字符串）。 */
function requireStringArrayAllowEmpty(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ArchitectureValidationError(`字段 ${field} 必须是数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ArchitectureValidationError(`字段 ${field}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/** 解析并校验架构师前四件。 */
export function parseArchitectureOutput(input: unknown): ArchitectureParts {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArchitectureValidationError("架构师输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;

  const storyFrameRaw = obj.storyFrame;
  if (typeof storyFrameRaw !== "object" || storyFrameRaw === null || Array.isArray(storyFrameRaw)) {
    throw new ArchitectureValidationError("字段 storyFrame 必须是对象");
  }
  const sf = storyFrameRaw as Record<string, unknown>;
  const storyFrame: StoryFrame = {
    coreStory: requireNonEmptyString(sf.coreStory, "storyFrame.coreStory"),
    coreConflict: requireNonEmptyString(sf.coreConflict, "storyFrame.coreConflict"),
    protagonistPath: requireStringArray(sf.protagonistPath, "storyFrame.protagonistPath"),
  };

  const volumeMapRaw = obj.volumeMap;
  if (!Array.isArray(volumeMapRaw) || volumeMapRaw.length === 0) {
    throw new ArchitectureValidationError("字段 volumeMap 必须是非空数组");
  }
  const volumeMap: VolumeMapItem[] = volumeMapRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ArchitectureValidationError(`字段 volumeMap[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    return {
      volume: requireNonEmptyString(o.volume, `volumeMap[${index}].volume`),
      title: requireNonEmptyString(o.title, `volumeMap[${index}].title`),
      goal: requireNonEmptyString(o.goal, `volumeMap[${index}].goal`),
      stages: requireStringArray(o.stages, `volumeMap[${index}].stages`),
    };
  });

  const cardsRaw = obj.characterCards;
  if (!Array.isArray(cardsRaw) || cardsRaw.length === 0) {
    throw new ArchitectureValidationError("字段 characterCards 必须是非空数组");
  }
  const characterCards: CharacterCard[] = cardsRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ArchitectureValidationError(`字段 characterCards[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    const tier = requireNonEmptyString(o.tier, `characterCards[${index}].tier`);
    if (tier !== "S" && tier !== "A" && tier !== "B") {
      throw new ArchitectureValidationError(`字段 characterCards[${index}].tier 只能是 S/A/B，收到：${tier}`);
    }
    const relationshipsRaw = o.relationships;
    if (!Array.isArray(relationshipsRaw)) {
      throw new ArchitectureValidationError(`字段 characterCards[${index}].relationships 必须是数组`);
    }
    const relationships = relationshipsRaw.map((rel, relIndex) => {
      if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
        throw new ArchitectureValidationError(`字段 characterCards[${index}].relationships[${relIndex}] 必须是对象`);
      }
      const r = rel as Record<string, unknown>;
      return {
        name: requireNonEmptyString(r.name, `characterCards[${index}].relationships[${relIndex}].name`),
        relation: requireNonEmptyString(r.relation, `characterCards[${index}].relationships[${relIndex}].relation`),
      };
    });
    return {
      name: requireNonEmptyString(o.name, `characterCards[${index}].name`),
      tier: tier as Tier,
      archetype: requireNonEmptyString(o.archetype, `characterCards[${index}].archetype`),
      traits: requireStringArray(o.traits, `characterCards[${index}].traits`),
      speechStyle: requireNonEmptyString(o.speechStyle, `characterCards[${index}].speechStyle`),
      secret: requireNonEmptyString(o.secret, `characterCards[${index}].secret`),
      knowledgeBoundary: requireStringArray(o.knowledgeBoundary, `characterCards[${index}].knowledgeBoundary`),
      relationships,
    };
  });

  const threadMap = parseThreadMap(obj.threadMap);

  return { storyFrame, volumeMap, characterCards, threadMap };
}

/** 解析并校验叙事线地图。 */
function parseThreadMap(input: unknown): ThreadMap {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArchitectureValidationError("字段 threadMap 必须是对象");
  }
  const obj = input as Record<string, unknown>;
  const linesRaw = obj.lines;
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) {
    throw new ArchitectureValidationError("字段 threadMap.lines 必须是非空数组");
  }
  const lines: ThreadLine[] = linesRaw.map((line, index) => {
    if (typeof line !== "object" || line === null || Array.isArray(line)) {
      throw new ArchitectureValidationError(`字段 threadMap.lines[${index}] 必须是对象`);
    }
    const o = line as Record<string, unknown>;
    const eventsRaw = o.events;
    if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) {
      throw new ArchitectureValidationError(`字段 threadMap.lines[${index}].events 必须是非空数组`);
    }
    const events: ThreadEvent[] = eventsRaw.map((ev, evIndex) => {
      if (typeof ev !== "object" || ev === null || Array.isArray(ev)) {
        throw new ArchitectureValidationError(`字段 threadMap.lines[${index}].events[${evIndex}] 必须是对象`);
      }
      const e = ev as Record<string, unknown>;
      const requires = requireStringArrayAllowEmpty(e.requires, `threadMap.lines[${index}].events[${evIndex}].requires`);
      return {
        id: requireNonEmptyString(e.id, `threadMap.lines[${index}].events[${evIndex}].id`),
        content: requireNonEmptyString(e.content, `threadMap.lines[${index}].events[${evIndex}].content`),
        volume: requireNonEmptyString(e.volume, `threadMap.lines[${index}].events[${evIndex}].volume`),
        requires,
        merge: e.merge === true,
      };
    });
    return {
      id: requireNonEmptyString(o.id, `threadMap.lines[${index}].id`),
      name: requireNonEmptyString(o.name, `threadMap.lines[${index}].name`),
      goal: requireNonEmptyString(o.goal, `threadMap.lines[${index}].goal`),
      events,
    };
  });
  return { lines };
}

/** 解析 hookIntention 的 tag 前缀；无 tag 返回 null。 */
export function extractHookTag(intention: string): string | null {
  const match = /^【([^】]+)】/.exec(intention.trim());
  return match === null ? null : match[1];
}

const PACING_VALUES: readonly Pacing[] = ["铺垫", "上升", "紧张", "释放", "舒缓"];

/** 解析并校验节拍板。 */
export function parseBeatBoardOutput(input: unknown, totalChapters: number): BeatBoard {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArchitectureValidationError("Director 输出必须是 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  const beatsRaw = obj.beats;
  if (!Array.isArray(beatsRaw)) {
    throw new ArchitectureValidationError("字段 beats 必须是数组");
  }
  const beats: Beat[] = beatsRaw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ArchitectureValidationError(`字段 beats[${index}] 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.chapter !== "number" || !Number.isInteger(o.chapter) || o.chapter <= 0) {
      throw new ArchitectureValidationError(`字段 beats[${index}].chapter 必须是正整数`);
    }
    const pacing = requireNonEmptyString(o.pacing, `beats[${index}].pacing`);
    if (!(PACING_VALUES as readonly string[]).includes(pacing)) {
      throw new ArchitectureValidationError(`字段 beats[${index}].pacing 只能是 ${PACING_VALUES.join("/")}，收到：${pacing}`);
    }
    const charactersRaw = o.characters;
    if (!Array.isArray(charactersRaw)) {
      throw new ArchitectureValidationError(`字段 beats[${index}].characters 必须是数组`);
    }
    const characters = charactersRaw.map((ch, chIndex) => {
      if (typeof ch !== "object" || ch === null || Array.isArray(ch)) {
        throw new ArchitectureValidationError(`字段 beats[${index}].characters[${chIndex}] 必须是对象`);
      }
      const c = ch as Record<string, unknown>;
      return {
        name: requireNonEmptyString(c.name, `beats[${index}].characters[${chIndex}].name`),
        action: requireNonEmptyString(c.action, `beats[${index}].characters[${chIndex}].action`),
      };
    });
    return {
      chapter: o.chapter,
      title: requireNonEmptyString(o.title, `beats[${index}].title`),
      mainBeat: requireNonEmptyString(o.mainBeat, `beats[${index}].mainBeat`),
      characters,
      threadId: requireNonEmptyString(o.threadId, `beats[${index}].threadId`),
      pacing: pacing as Pacing,
      emotionalArc: requireNonEmptyString(o.emotionalArc, `beats[${index}].emotionalArc`),
      hookIntentions: requireStringArrayAllowEmpty(o.hookIntentions, `beats[${index}].hookIntentions`),
      plannedPayoffOf: requireStringArrayAllowEmpty(o.plannedPayoffOf, `beats[${index}].plannedPayoffOf`),
    };
  });
  return { beats };
}

/**
 * 节拍板验收闸门（代码判定，不靠模型自觉）。返回违规说明列表；空数组 = 通过。
 * 硬性检查：mainBeat 非空且 ≤60 字 / 相邻 3 章不全为「释放」/ hookIntentions 密度 0.2–0.5 /
 *          每个 hookIntention tag 都有回收章。
 * warning 检查：平均埋设→回收章距是否合理（> 总章数 1/3 时提示）。
 */
export function validateBeatBoard(board: BeatBoard, totalChapters: number): string[] {
  const violations: string[] = [];
  const warnings: string[] = [];
  const beats = board.beats;

  // 章数应与 targetChapters 一致（文档：长度 = targetChapters）
  if (beats.length !== totalChapters) {
    violations.push(`节拍板章数 ${beats.length} 不等于目标总章数 ${totalChapters}`);
  }

  // 1. 每章 mainBeat 非空且 ≤60 字（100%）
  for (const beat of beats) {
    const length = Array.from(beat.mainBeat.replace(/\s+/g, "")).length;
    if (length === 0) {
      violations.push(`ch${beat.chapter} mainBeat 为空`);
    } else if (length > 60) {
      violations.push(`ch${beat.chapter} mainBeat 超 60 字（${length} 字）：${beat.mainBeat.slice(0, 30)}…`);
    }
  }

  // 2. 相邻 3 章 pacing 不全为「释放」
  for (let i = 0; i + 2 < beats.length; i += 1) {
    if (beats[i].pacing === "释放" && beats[i + 1].pacing === "释放" && beats[i + 2].pacing === "释放") {
      violations.push(`ch${beats[i].chapter}~ch${beats[i + 2].chapter} 连续 3 章 pacing 全为「释放」`);
    }
  }

  // 3. hookIntentions 总数 / 总章数 ∈ [0.2, 0.5]
  const totalHooks = beats.reduce((sum, beat) => sum + beat.hookIntentions.length, 0);
  const density = totalChapters === 0 ? 0 : totalHooks / totalChapters;
  if (totalChapters > 0 && (density < 0.2 || density > 0.5)) {
    violations.push(
      `hookIntentions 密度 ${density.toFixed(2)}（${totalHooks}/${totalChapters}）不在 [0.2, 0.5] 区间`,
    );
  }

  // 4. 每个 hookIntention 有对应回收章（全书 plannedPayoffOf 必须引用其 tag）
  const allTags: string[] = [];
  for (const beat of beats) {
    for (const intention of beat.hookIntentions) {
      const tag = extractHookTag(intention);
      if (tag === null) {
        violations.push(`ch${beat.chapter} hookIntention 缺少 tag 前缀（应为【ch${beat.chapter}-h1】格式）：${intention.slice(0, 20)}`);
      } else {
        allTags.push(tag);
      }
    }
  }
  const payoffTags = new Set(beats.flatMap((beat) => beat.plannedPayoffOf));
  const seenTags = new Set<string>();
  for (const tag of allTags) {
    if (seenTags.has(tag)) {
      continue;
    }
    seenTags.add(tag);
    if (!payoffTags.has(tag)) {
      violations.push(`hook tag ${tag} 没有任何章节的 plannedPayoffOf 回收它（只埋不收 → blocking）`);
    }
  }

  // warning：平均埋设→回收章距
  if (allTags.length > 0) {
    const distances: number[] = [];
    for (const tag of allTags) {
      const buried = /^ch(\d+)/.exec(tag);
      if (buried === null) {
        continue;
      }
      const buriedChapter = Number(buried[1]);
      const payoffChapter = beats.find((b) => b.plannedPayoffOf.includes(tag))?.chapter;
      if (payoffChapter !== undefined && payoffChapter > buriedChapter) {
        distances.push(payoffChapter - buriedChapter);
      }
    }
    if (distances.length > 0) {
      const avg = distances.reduce((a, b) => a + b, 0) / distances.length;
      if (avg > totalChapters / 3) {
        warnings.push(`平均埋设→回收章距 ${avg.toFixed(1)} 章，超过总章数 1/3（${Math.round(totalChapters / 3)}），建议把部分回收提前`);
      }
    }
  }

  // warning 附在末尾（带前缀），不阻断
  for (const warning of warnings) {
    violations.push(`[warning] ${warning}`);
  }
  return violations;
}
