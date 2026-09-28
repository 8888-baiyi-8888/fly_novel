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
import { Beat, BeatBoard, ThreadEvent, ThreadMap, VolumeMapItem } from "./types";

/** 每块最大章数：25 章 ≈ 18KB 输出，单次模型调用稳定完成。
 *  40 章约 30KB，250 章级大书单次生成仍易超过请求超时，故收紧到 25 章。 */
export const MAX_CHUNK_SIZE = 25;

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
    const offset = chunk.startChapter - 1;
    for (const beat of chunkBeatsList[i]) {
      beats.push({
        ...beat,
        chapter: beat.chapter + offset,
        hookIntentions: beat.hookIntentions.map((intention) => renumberHookIntention(intention, offset)),
        plannedPayoffOf: beat.plannedPayoffOf.map((tag) => renumberTagRef(tag, offset)),
      });
    }
  }
  return { beats };
}

/** 【chN-…】→【ch(N+offset)-…】（只改开头 tag 的章号，正文不动）。 */
function renumberHookIntention(intention: string, offset: number): string {
  return intention.replace(/^【ch(\d+)/, (_match, num: string) => `【ch${Number(num) + offset}`);
}

/** chN-… → ch(N+offset)-…（plannedPayoffOf 引用整体就是 tag）。 */
function renumberTagRef(tag: string, offset: number): string {
  return tag.replace(/^ch(\d+)/, (_match, num: string) => `ch${Number(num) + offset}`);
}
