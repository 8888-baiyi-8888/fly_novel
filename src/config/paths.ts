import { join } from "node:path";

/** 固定的应用数据目录，不依赖启动时的工作目录。 */
export const APP_HOME = "E:/typescript/fly_novel/.fly-novel";

/** 项目根目录（APP_HOME 的上一级）。 */
export const PROJECT_ROOT = join(APP_HOME, "..");

/** 产物根目录：N0/N1 等节点生成物统一落盘位置。 */
export const ARTIFACTS_ROOT = join(PROJECT_ROOT, "artifacts");

/** N0 产物目录：整理后的原始输入文本。 */
export const N0_RAW_INPUT_DIR = join(ARTIFACTS_ROOT, "n0-raw-input");

/** N1 产物目录：创意草案 JSON。 */
export const N1_DRAFT_DIR = join(ARTIFACTS_ROOT, "n1-draft");

/** N2 产物目录：书籍配置 BookConfig JSON。 */
export const N2_BOOK_CONFIG_DIR = join(ARTIFACTS_ROOT, "n2-book-config");

/** N3 产物目录：故事圣经 + 书籍规则 JSON。 */
export const N3_STORY_BIBLE_DIR = join(ARTIFACTS_ROOT, "n3-story-bible");

/** N4 产物目录：长期创作控制四件套 JSON。 */
export const N4_CONTROLS_DIR = join(ARTIFACTS_ROOT, "n4-controls");
