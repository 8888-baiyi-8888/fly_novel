/**原始输入整理节点 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NovelWorkflowState } from "../state";
import { N0_RAW_INPUT_DIR } from "../../../novel-flow/paths";
import { NormalizedInputAgent } from "../../../novel-flow/normalized-input/normalized-input-agent";
import {
  latestRawInputArtifact,
  saveRawInput,
} from "../artifacts";


export async function runNormalizedInput(
  state: Pick<NovelWorkflowState, "rawInput" | "normalizedInput">,
  normalizedInputAgent: NormalizedInputAgent,
  persist = true,
): Promise<Partial<NovelWorkflowState>> {
  const existing = latestRawInputArtifact();

  // 已存在 NI 产物，直接复用
  if (existing !== null) {
    // TODO: 这里的逻辑应该更改为通过novel_id获取对应内容
    
    const path = join(N0_RAW_INPUT_DIR, existing);
    const normalizedInput = readFileSync(path, "utf8");

    console.log(
      `\n已存在 normalized input 产物：${path}\n` +
      `（跳过 原始输入整理节点，直接作为 N1 输入；删除该文件可强制重新扩展）\n`,
    );
    state.normalizedInput = {
      normalizedInput,
      rawInputFromCache: true,
    }
    return state
  }

  // 调用 Agent 生成 NI 产物
  const normalizedInput = await normalizedInputAgent.createRawInput(
    state.rawInput.userInput,
  );

  console.log(
    "\n【normalized input 节点 扩展后的原始输入】\n" +
    normalizedInput +
    "\n",
  );

  if (persist) saveRawInput(normalizedInput);
  state.normalizedInput = {
      normalizedInput,
      rawInputFromCache: false,
    }
  return state
};
