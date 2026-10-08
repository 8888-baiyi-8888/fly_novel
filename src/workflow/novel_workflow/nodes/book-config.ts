import { buildBookConfig } from "../../../novel-flow/book-config";
import { saveBookConfig } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 从创意草案固化书籍运行参数。 */
export function runBookConfig(state: Pick<NovelWorkflowState, "draft">, persist = true): Partial<NovelWorkflowState> {
  if (state.draft === undefined) {
    throw new Error("缺少 draft 节点产物，无法生成书籍配置");
  }
  const bookConfig = buildBookConfig(state.draft);
  if (persist) saveBookConfig(bookConfig);
  return { bookConfig };
}
