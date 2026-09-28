import { ChatRequest, ChatResponse, ModelClient } from "../adapters/model-contract";
import { CreativeDraft } from "../draft/types";
import {
  buildBeatBoardChunkMessages,
  buildBeatBoardChunkRetryMessage,
  buildBeatBoardMessages,
  buildBeatBoardRetryMessage,
} from "./prompt";
import { BEAT_BOARD_JSON_DESCRIPTION } from "./schema";
import { parseBeatBoardOutput, validateBeatBoard, validateChunkHookRefs, extractHookTag } from "./validate";
import { ArchitectureParts, Beat, BeatBoard } from "./types";
import { BeatChunk, mergeChunkBeats, planBeatChunks, renumberBeatToGlobal, renumberTagToGlobal } from "./chunk";

export interface DirectorAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数（块内），默认 1。 */
  maxRetries?: number;
  /**
   * 分块生成节拍板（按卷切块，单块 ≤20 章，块间注入衔接上下文，合并后全书校验）。
   * 真实模型大书推荐开启；内存模型演示保持单次调用。
   */
  chunked?: boolean;
  /** 全书合并验收闸门失败后的整书重试轮数，默认 1（即最多共 2 轮全书生成）。 */
  wholeBoardRetries?: number;
}

/** Director（节拍板）失败。 */
export class DirectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectorError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 块内已埋未收的伏笔（供下一块衔接）。 */
export interface OpenHook {
  tag: string;
  intention: string;
}

/**
 * Director Agent（N5 节拍板）：把架构师前四件 + 创作简报
 * 细化成全书章级蓝图（beats，长度 = targetChapters），并过代码验收闸门。
 *
 * 两种模式：
 * - 单次（默认）：一次模型调用输出全书节拍板（适合 100 章内）；
 * - 分块（chunked）：按卷切块、每块一次调用、块间衔接、合并后全书校验
 *   （适合大书；150 章单次输出曾超 180s 请求超时）。
 */
export class DirectorAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;
  private readonly chunked: boolean;
  private readonly wholeBoardRetries: number;

  constructor(options: DirectorAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
    this.chunked = options.chunked ?? false;
    this.wholeBoardRetries = options.wholeBoardRetries ?? 1;
  }

  /** 生成节拍板（内部按 chunked 选项路由到单次或分块）。 */
  async createBeatBoard(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    if (this.chunked) {
      return this.createBeatBoardChunked(draft, parts);
    }
    return this.createBeatBoardOnce(draft, parts);
  }

  /** 单次生成（原逻辑）：一次调用全书节拍板。 */
  private async createBeatBoardOnce(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages:
            attempt === 0
              ? buildBeatBoardMessages(draft, parts)
              : [...buildBeatBoardMessages(draft, parts), buildBeatBoardRetryMessage(describeError(lastError))],
          structured: { name: "beat_board", description: BEAT_BOARD_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const beatBoard = parseBeatBoardOutput(parsed, draft.targetChapters);
        const violations = validateBeatBoard(beatBoard, draft.targetChapters);
        if (violations.length > 0) {
          throw new DirectorError(`节拍板验收闸门未通过：\n${violations.join("\n")}`);
        }
        return beatBoard;
      } catch (error) {
        lastError = error;
      }
    }
    throw new DirectorError(`节拍板生成失败：${describeError(lastError)}`);
  }

  /** 分块生成：每块一次调用，块间注入前尾 + 未回收伏笔，合并后全书校验；闸门失败整书重试。 */
  private async createBeatBoardChunked(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    const chunks = planBeatChunks(draft.targetChapters, parts.volumeMap);
    if (chunks.length === 0) {
      throw new DirectorError(`无法分块：目标章数 ${draft.targetChapters} 或分卷数无效`);
    }
    let lastViolations: string[] = [];
    for (let round = 0; round <= this.wholeBoardRetries; round += 1) {
      const chunkBeatsList: Beat[][] = [];
      const openHooks: OpenHook[] = [];
      let prevTail: Beat[] = [];
      for (const chunk of chunks) {
        const beats = await this.callChunkOnce(draft, parts, chunk, prevTail, openHooks);
        updateOpenHooks(openHooks, beats, chunk);
        chunkBeatsList.push(beats);
        // 注入下一块的前尾用全局号（否则块长不同时块内号错位）
        prevTail = beats.slice(-5).map((beat) => renumberBeatToGlobal(beat, chunk));
      }
      const merged = mergeChunkBeats(chunks, chunkBeatsList);
      const violations = validateBeatBoard(merged, draft.targetChapters);
      if (violations.length === 0) {
        return merged;
      }
      lastViolations = violations;
      if (round < this.wholeBoardRetries) {
        console.warn(`节拍板全书闸门未过（第 ${round + 1} 轮，${violations.length} 处），整书重跑第 ${round + 2} 轮…`);
      }
    }
    throw new DirectorError(
      `节拍板验收闸门未通过（分块合并后，重试 ${this.wholeBoardRetries} 轮仍失败）：\n${lastViolations.join("\n")}`,
    );
  }

  /** 单块调用：一次模型调用生成某块的节拍（块内章号 1..n），带块内重试。 */
  private async callChunkOnce(
    draft: CreativeDraft,
    parts: ArchitectureParts,
    chunk: BeatChunk,
    prevTail: Beat[],
    openHooks: OpenHook[],
  ): Promise<Beat[]> {
    const chunkLength = chunk.endChapter - chunk.startChapter + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages:
            attempt === 0
              ? buildBeatBoardChunkMessages(draft, parts, chunk, prevTail, openHooks)
              : [
                  ...buildBeatBoardChunkMessages(draft, parts, chunk, prevTail, openHooks),
                  buildBeatBoardChunkRetryMessage(describeError(lastError), chunk),
                ],
          structured: { name: "beat_board_chunk", description: BEAT_BOARD_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const board = parseBeatBoardOutput(parsed, chunkLength);
        if (board.beats.length !== chunkLength) {
          throw new DirectorError(`本块节拍数 ${board.beats.length} 不等于块章数 ${chunkLength}`);
        }
        // 块内 hook 引用校验：拦截编造 tag（孤儿回收），块内重试，避免全书闸门失败整书重跑
        const chunkViolations = validateChunkHookRefs(board.beats, openHooks);
        if (chunkViolations.length > 0) {
          throw new DirectorError(`本块 hook 引用校验未过：\n${chunkViolations.join("\n")}`);
        }
        return board.beats;
      } catch (error) {
        lastError = error;
      }
    }
    throw new DirectorError(
      `节拍板块生成失败（${chunk.id} ch${chunk.startChapter}-ch${chunk.endChapter}）：${describeError(lastError)}`,
    );
  }
}

/** 维护已埋未收伏笔清单：埋设加入、回收移除（供下一块衔接与跨块闭环）。tag 统一存全局号。 */
function updateOpenHooks(openHooks: OpenHook[], beats: Beat[], chunk: BeatChunk): void {
  for (const beat of beats) {
    for (const intention of beat.hookIntentions) {
      const tag = extractHookTag(intention);
      if (tag !== null) {
        openHooks.push({ tag: renumberTagToGlobal(tag, chunk), intention });
      }
    }
    for (const tag of beat.plannedPayoffOf) {
      const index = openHooks.findIndex((hook) => hook.tag === tag);
      if (index >= 0) {
        openHooks.splice(index, 1);
      }
    }
  }
}
