/**
 * novel/architecture/chunk：节拍板分块生成（N5 超时根治方案）。
 *
 * 为什么分块：Director 一次性输出全书节拍板时，章数越多输出越大，
 * 100 章约 66KB，150 章约 100KB+，单次模型调用容易超过请求超时。
 * 分块后每块一次调用（单块 ≤40 章 ≈ 30KB），不再有大输出。
 *
 * 分块规则：按卷切块，单卷 >40 章再拆半，每块 ≤40 章；
 * 块之间注入「上一块尾 5 章 + 已埋未收伏笔清单」保证衔接；
 * 合并后仍跑全书级验收闸门（validateBeatBoard），产物结构不变。
 */
import { extractHookTag } from "./validate";
import { Beat, BeatBoard, ThreadEvent, ThreadMap, VolumeMapItem } from "./types";

/** 每块最大章数：20 章 ≈ 15KB 输出，慢速模型（glm 系）单次调用可稳定完成。 */
export const MAX_CHUNK_SIZE = 20;

/** 节拍板分块：一次生成一节的章区间与卷信息。 */
export interface BeatChunk {
  /** 块 id，如 V1 / V1-2（单卷拆成多块时带子序号）。 */
  id: string;
  /** 卷名，如 "第一卷"。 */
  volume: string;
  title: string;
  goal: string;
  stages: string[];
  /** 本块章号区间（全局 1-based）。 */
  startChapter: number;
  endChapter: number;
}

/** 把 "第一卷" / "第1卷" / "第三卷" 统一成数字；解析失败返回 null。 */
export function volumeNumber(value: string): number | null {
  const match = /第\s*([0-9一二三四五六七八九十]+)\s*卷/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const raw = match[1];
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const chinese: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return chinese[raw] ?? null;
}

/** 按卷切分全书章数：均分 + 余数给前几卷；单卷 >40 章再拆半（每块 ≤40 章）。 */
export function planBeatChunks(targetChapters: number, volumes: VolumeMapItem[]): BeatChunk[] {
  if (targetChapters <= 0 || volumes.length === 0) {
    return [];
  }
  const chunks: BeatChunk[] = [];
  let cursor = 1;
  const per = Math.floor(targetChapters / volumes.length);
  const remainder = targetChapters % volumes.length;

  volumes.forEach((volume, index) => {
    let count = per + (index < remainder ? 1 : 0);
    if (count <= 0) {
      return;
    }
    const volumeKey = `V${index + 1}`;
    if (count > MAX_CHUNK_SIZE) {
      // 单卷拆成多块：尽量均匀，每块 ≤ MAX_CHUNK_SIZE
      const subCount = Math.ceil(count / MAX_CHUNK_SIZE);
      const base = Math.floor(count / subCount);
      const subRemainder = count % subCount;
      for (let j = 0; j < subCount; j += 1) {
        const size = base + (j < subRemainder ? 1 : 0);
        chunks.push({
          id: `${volumeKey}-${j + 1}`,
          volume: volume.volume,
          title: volume.title,
          goal: volume.goal,
          stages: volume.stages,
          startChapter: cursor,
          endChapter: cursor + size - 1,
        });
        cursor += size;
      }
    } else {
      chunks.push({
        id: volumeKey,
        volume: volume.volume,
        title: volume.title,
        goal: volume.goal,
        stages: volume.stages,
        startChapter: cursor,
        endChapter: cursor + count - 1,
      });
      cursor += count;
    }
  });
  return chunks;
}

/** 本块必须覆盖的事件：threadMap 中卷位与块卷一致的（含前置事件信息）。 */
export function collectChunkEvents(threadMap: ThreadMap, chunk: BeatChunk): ThreadEvent[] {
  const chunkVolume = volumeNumber(chunk.volume);
  if (chunkVolume === null) {
    return [];
  }
  const events: ThreadEvent[] = [];
  for (const line of threadMap.lines) {
    for (const event of line.events) {
      if (volumeNumber(event.volume) === chunkVolume) {
        events.push(event);
      }
    }
  }
  return events;
}

/** 合并各块节拍：块内章号 1..n → 全局章号（startChapter 起），保持块顺序。
 * hookIntention 的【chN-…】tag 与 plannedPayoffOf 引用按块内号命名，
 * 合并时必须一并重编号为全局号，否则不同块会撞 tag（如块 4 第 1 章也写成 ch1-h1）。 */
export function mergeChunkBeats(chunks: BeatChunk[], chunkBeatsList: Beat[][]): BeatBoard {
  const beats: Beat[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkBeats = chunkBeatsList[i];
    // 本块已埋 tag（块内号集合）：plannedPayoffOf 引用命中它才重编号；
    // 引用 openHooks 全局号（不在本块已埋）必须保留原样，否则二次偏移变孤儿。
    const buriedTags = new Set<string>();
    for (const beat of chunkBeats) {
      for (const intention of beat.hookIntentions) {
        const tag = extractHookTag(intention);
        if (tag !== null) {
          buriedTags.add(tag);
        }
      }
    }
    for (const beat of chunkBeats) {
      beats.push(renumberBeatToGlobal(beat, chunk, buriedTags));
    }
  }
  return { beats };
}

/**
 * 块内号 → 全局号：tag 命中 buriedTags（本块已埋，块内号）→ 加 offset；
 * 否则视为 openHooks 全局引用（不重编号）。
 */
export function renumberTagToGlobal(tag: string, chunk: BeatChunk, buriedTags?: Set<string>): string {
  const chunkLength = chunk.endChapter - chunk.startChapter + 1;
  return tag.replace(/^ch(\d+)/, (_match, num: string) => {
    const blockLocal = Number(num);
    const isBlockLocal = buriedTags === undefined ? blockLocal <= chunkLength : buriedTags.has(tag);
    const global = isBlockLocal ? blockLocal + chunk.startChapter - 1 : blockLocal;
    return `ch${global}`;
  });
}

/** 【chN-…】→ 全局号（只改开头 tag 的章号，正文不动）。埋设侧无条件块内→全局。 */
export function renumberIntentionToGlobal(intention: string, chunk: BeatChunk): string {
  const chunkLength = chunk.endChapter - chunk.startChapter + 1;
  return intention.replace(/^【ch(\d+)/, (_match, num: string) => {
    const blockLocal = Number(num);
    const global = blockLocal <= chunkLength ? blockLocal + chunk.startChapter - 1 : blockLocal;
    return `【ch${global}`;
  });
}

/** 块内节拍 → 全局节拍（章号 + 所有 tag 引用），供合并、prevTail 注入、openHooks 提取统一使用。 */
export function renumberBeatToGlobal(beat: Beat, chunk: BeatChunk, buriedTags?: Set<string>): Beat {
  return {
    ...beat,
    chapter: beat.chapter + chunk.startChapter - 1,
    hookIntentions: beat.hookIntentions.map((intention) => renumberIntentionToGlobal(intention, chunk)),
    plannedPayoffOf: beat.plannedPayoffOf.map((tag) => renumberTagToGlobal(tag, chunk, buriedTags)),
  };
}
