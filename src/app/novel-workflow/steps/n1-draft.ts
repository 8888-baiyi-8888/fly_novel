import { ClarifyUserAnswer, CreativeDraftAgent } from "../../../novel-flow/draft/creative-draft-agent";
import { CreativeDraft } from "../../../novel-flow/draft/types";
import { readLatestRawInput, saveDraft } from "../artifacts";

export type CliAskerFactory = () => { ask: ClarifyUserAnswer; close: () => void };

export async function generateDraft(
  n1: CreativeDraftAgent,
  rawInput: string,
  clarify: boolean,
  createAsker?: CliAskerFactory,
): Promise<CreativeDraft> {
  if (clarify && createAsker !== undefined) {
    const asker = createAsker();
    try {
      return await n1.createDraftWithClarification(rawInput, asker.ask);
    } finally {
      asker.close();
    }
  }
  return n1.createDraft(rawInput);
}

export async function runN1Step(
  n1: CreativeDraftAgent,
  createAsker: CliAskerFactory | undefined,
  persist: boolean,
): Promise<void> {
  const rawInput = readLatestRawInput();
  if (rawInput === null) {
    throw new Error("没有找到 N0 产物（artifacts/n0-raw-input/），请先运行 --step n0 或全链路");
  }
  const draft = await generateDraft(n1, rawInput, createAsker !== undefined, createAsker);
  console.log(JSON.stringify(draft, null, 2));
  if (persist) {
    saveDraft(draft);
  }
}
