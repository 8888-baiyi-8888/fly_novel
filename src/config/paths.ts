/** 应用数据目录（settings.json / .credentials.json / .encryption-key）：仓库根下的 .fly-novel。
 *  历史值曾硬编码为 D:/mydata/GitHub/fly_novel/.fly-novel（已不存在），修正为随仓库移动。 */
export const APP_HOME = process.cwd() + "/.fly-novel";
