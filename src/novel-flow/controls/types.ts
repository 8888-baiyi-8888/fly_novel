/**
 * novel/controls：长期创作控制（Long-term Creative Controls）。
 * 对应建书第 4 步（与 N2/N3 并行）：把「作者想写什么」单独分流成四件套，
 * 与世界事实（故事圣经 N3）、写作规则（书籍规则 N3）严格分离。
 */

/** 分卷方向：比章节大纲更高层的方向规划（N5 分卷规划的前身）。 */
export interface VolumeDirection {
  /** 卷名，如 "第一卷"。 */
  volume: string;
  /** 本卷方向：要完成什么 / 核心张力是什么。 */
  direction: string;
}

/** 长期创作控制四件套。 */
export interface LongTermControls {
  bookId: string;
  title: string;
  /** 作者意图：作者为什么要这样写（长期，全书有效，永不失效）。 */
  authorIntent: string;
  /** 当前重点：最近一段时间主要解决什么（近期，随进度滚动更新）。 */
  currentFocus: string[];
  /** 分卷方向：每卷一条。 */
  volumeDirections: VolumeDirection[];
  /** 创作约束：不能怎么写（硬边界）。 */
  constraints: string[];
}
