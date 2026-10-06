/** 原始输入整理节点 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RawInputAgent } from "../../../novel-flow/normalized-input/normalized-input-agent";
import { N0_RAW_INPUT_DIR } from "../../../novel-flow/paths";
import { latestRawInputArtifact, readLatestRawInput, saveRawInput } from "../../../workflow/novel_workflow/artifacts";

export async function resolveRawInput(
  rawInputAgent: RawInputAgent,
  initialInput: string,
): Promise<{ rawInput: string; fromCache: boolean }> {
  const existing = latestRawInputArtifact();
  if (existing !== null) {
    const path = join(N0_RAW_INPUT_DIR, existing);
    const cached = readFileSync(path, "utf8");
    console.log(`\n已存在 原始输入整理节点 产物：${path}\n（跳过 原始输入整理节点，直接作为 N1 输入；删除该文件可强制重新扩展）\n`);
    return { rawInput: cached, fromCache: true };
  }
  const rawInput = await rawInputAgent.createRawInput(initialInput);
  console.log("\n【原始输入整理节点 扩展后的原始输入】\n" + rawInput + "\n");
  return { rawInput, fromCache: false };
}

export async function runN0Step(rawInputAgent: RawInputAgent, initialInput: string, persist: boolean): Promise<void> {
  const { rawInput, fromCache } = await resolveRawInput(rawInputAgent, initialInput);
  if (persist && !fromCache) {
    saveRawInput(rawInput);
  }
}

export function requireLatestRawInput(): string {
  const rawInput = readLatestRawInput();
  if (rawInput === null) {
    throw new Error("没有找到 N0 产物（artifacts/n0-raw-input/），请先运行 --step n0 或全链路");
  }
  return rawInput;
}
