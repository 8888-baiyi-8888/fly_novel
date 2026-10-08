/**
 * 建书管线（novel-flow）产物路径：基于仓库根（进程工作目录）。
 * 与章节流 src/config/paths.ts（凭据系统 APP_HOME）分离，互不影响。
 * 约束：建书命令和书目录加载须在仓库根运行。
 */
import { join } from "node:path";

/** 仓库根 = 进程工作目录。 */
export const PROJECT_ROOT = process.cwd();

/** 产物根目录：N0/N1 等节点生成物统一落盘位置。 */
export const ARTIFACTS_ROOT = join(PROJECT_ROOT, ".fly-novel-store");

/** 旧版建书入口的 N0 产物目录；小说级 LangGraph 使用 artifactRoot/novelId/normalized_input。 */
export const N0_RAW_INPUT_DIR = join(ARTIFACTS_ROOT, "n0-raw-input");

/** N1 产物目录：创意草案 JSON。 */
export const N1_DRAFT_DIR = join(ARTIFACTS_ROOT, "n1-draft");

/** N2 产物目录：书籍配置 BookConfig JSON。 */
export const N2_BOOK_CONFIG_DIR = join(ARTIFACTS_ROOT, "n2-book-config");

/** N3 产物目录：故事圣经 + 书籍规则 JSON。 */
export const N3_STORY_BIBLE_DIR = join(ARTIFACTS_ROOT, "n3-story-bible");

/** N4 产物目录：长期创作控制四件套 JSON。 */
export const N4_CONTROLS_DIR = join(ARTIFACTS_ROOT, "n4-controls");

/** N5 产物目录：小说静态架构五件套 JSON。 */
export const N5_ARCHITECTURE_DIR = join(ARTIFACTS_ROOT, "n5-architecture");

/** N6 产物目录：初始化运行状态 State₀ 六类 JSON。 */
export const N6_STATE0_DIR = join(ARTIFACTS_ROOT, "n6-state0");

/** N7 产物目录：持久化工作空间（书项目目录，bookId 子目录）。 */
export const N7_WORKSPACE_DIR = join(ARTIFACTS_ROOT, "n7-workspace");
