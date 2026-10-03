import { buildBookConfig } from "../../../novel-flow/book-config";
import { readLatestDraft, saveBookConfig } from "../artifacts";

export async function runN2Only(): Promise<void> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  const config = buildBookConfig(draft);
  console.log(`\n【N2 书籍配置】已创建书籍：${config.bookId}（${config.title}）`);
  console.log(JSON.stringify(config, null, 2));
  saveBookConfig(config);
}
