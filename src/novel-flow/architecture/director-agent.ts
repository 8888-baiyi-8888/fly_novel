import { ChatRequest, ChatResponse, ModelClient } from "../adapters/model-contract";
import { CreativeDraft } from "../draft/types";
import {
  buildBeatBoardChunkMessages,
  buildBeatBoardChunkRetryMessage,
  buildBeatBoardMessages,
  buildBeatBoardRepairMessages,
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
  /**
   * 校验失败后自动调用 LLM 修复节拍板（方案2）。默认 true。
   * 只修复 hook 相关字段，不动剧情；最多 maxRepairAttempts 次，仍失败才阻断。
   */
  autoRepair?: boolean;
  /** 校验失败后最大自动修复次数，默认 2。 */
  maxRepairAttempts?: number;
  /** 全书合并验收闸门失败后的整书重试轮数，默认 1（即最多共 2 轮全书生成）。autoRepair 修完仍失败才走到整书重试。 */
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
 * 三种能力：
 * - 单次（默认）：一次模型调用输出全书节拍板（适合 100 章内）；
 * - 分块（chunked）：按卷切块、每块一次调用、块间衔接、合并后全书校验
 *   （适合大书；150 章单次输出曾超 180s 请求超时）；
 * - 自动修复（autoRepair）：全书校验失败时，把「节拍板 + 错误清单」喂回 LLM，
 *   只修复 hook 字段，最多 maxRepairAttempts 次，闭环后重新校验。
 */
export class DirectorAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;
  private readonly chunked: boolean;
  private readonly autoRepair: boolean;
  private readonly maxRepairAttempts: number;
  private readonly wholeBoardRetries: number;

  constructor(options: DirectorAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
    this.chunked = options.chunked ?? false;
    this.autoRepair = options.autoRepair ?? true;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
    this.wholeBoardRetries = options.wholeBoardRetries ?? 1;
  }

  /** 生成节拍板（内部按 chunked 选项路由到单次或分块，均接自动修复）。 */
  async createBeatBoard(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    if (this.chunked) {
      return this.createBeatBoardChunked(draft, parts);
    }
    return this.createBeatBoardOnce(draft, parts);
  }

  /** 单次生成：先结构解析（失败按 maxRetries 重试），再闸门校验 + 自动修复。 */
  private async createBeatBoardOnce(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    let lastError: unknown;
    let board: BeatBoard | null = null;
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
        board = parseBeatBoardOutput(parsed, draft.targetChapters);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (board === null) {
      throw new DirectorError(`节拍板生成失败：${describeError(lastError)}`);
    }
    return this.gateAndRepair(board, draft.targetChapters);
  }

  /** 分块生成：每块一次调用，块间注入前尾 + 未回收伏笔，合并后全书校验；
   *  校验失败先 autoRepair 修复，仍失败再整书重试 wholeBoardRetries 轮。 */
  private async createBeatBoardChunked(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    const chunks = planBeatChunks(draft.targetChapters, parts.volumeMap);
    if (chunks.length === 0) {
      throw new DirectorError(`无法分块：目标章数 ${draft.targetChapters} 或分卷数无效`);
    }
    let lastViolations: string[] = [];
    console.log(`【N5 节拍板】全书 ${draft.targetChapters} 章，分 ${chunks.length} 块生成`);
    for (let round = 0; round <= this.wholeBoardRetries; round += 1) {
      const chunkBeatsList: Beat[][] = [];
      const openHooks: OpenHook[] = [];
      let prevTail: Beat[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        console.log(
          `【N5 节拍板】正在生成第 ${i + 1}/${chunks.length} 块（${chunk.id}：ch${chunk.startChapter}-ch${chunk.endChapter}，${chunk.endChapter - chunk.startChapter + 1} 章），单块约需 1-5 分钟，请稍候…`,
        );
        const beats = await this.callChunkOnce(draft, parts, chunk, prevTail, openHooks);
        updateOpenHooks(openHooks, beats, chunk);
        chunkBeatsList.push(beats);
        prevTail = beats.slice(-5).map((b) => renumberBeatToGlobal(b, chunk));
        console.log(`【N5 节拍板】第 ${i + 1}/${chunks.length} 块完成（${chunk.id}）`);
      }
      console.log(`【N5 节拍板】全部 ${chunks.length} 块生成完成，正在合并校验…`);
      let board = mergeChunkBeats(chunks, chunkBeatsList);
      let violations = validateBeatBoard(board, draft.targetChapters);
      if (violations.length > 0 && this.autoRepair) {
        for (let attempt = 0; attempt < this.maxRepairAttempts; attempt += 1) {
          board = await this.repairBeatBoard(board, violations, draft.targetChapters);
          violations = validateBeatBoard(board, draft.targetChapters);
          if (violations.length === 0) break;
        }
      }
      if (violations.length === 0) {
        return board;
      }
      lastViolations = violations;
      if (round < this.wholeBoardRetries) {
        console.warn(`节拍板全书闸门未过（第 ${round + 1} 轮，${violations.length} 处，自动修复 ${this.maxRepairAttempts} 次后仍失败），整书重跑第 ${round + 2} 轮…`);
      }
    }
    throw new DirectorError(
      `节拍板验收闸门未通过（分块合并后，自动修复 ${this.maxRepairAttempts} 次、整书重试 ${this.wholeBoardRetries} 轮仍失败）：
${lastViolations.join("\n")}`,
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

  /** 闸门校验 + 自动修复闭环：校验失败则调 LLM 只修 hook 字段，最多 maxRepairAttempts 次。 */
  private async gateAndRepair(board: BeatBoard, totalChapters: number): Promise<BeatBoard> {
    let violations = validateBeatBoard(board, totalChapters);
    if (violations.length > 0 && this.autoRepair) {
      for (let attempt = 0; attempt < this.maxRepairAttempts; attempt += 1) {
        board = await this.repairBeatBoard(board, violations, totalChapters);
        violations = validateBeatBoard(board, totalChapters);
        if (violations.length === 0) {
          break;
        }
      }
    }
    if (violations.length > 0) {
      const suffix = this.autoRepair ? `（已自动修复 ${this.maxRepairAttempts} 次）` : "";
      throw new DirectorError(`节拍板验收闸门未通过${suffix}：\n${violations.join("\n")}`);
    }
    return board;
  }

  /** 调 LLM 修复节拍板：把「节拍板 + 错误清单」喂回，只增删 hook 相关字段，返回修复后节拍板。 */
  private async repairBeatBoard(board: BeatBoard, violations: string[], totalChapters: number): Promise<BeatBoard> {
    const request: ChatRequest = {
      messages: buildBeatBoardRepairMessages(board, violations, totalChapters),
      structured: { name: "beat_board_repair", description: BEAT_BOARD_JSON_DESCRIPTION },
      temperature: 0.2,
    };
    const response: ChatResponse = await this.model.chat(request);
    const parsed: unknown = JSON.parse(response.content);
    return parseBeatBoardOutput(parsed, totalChapters);
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
