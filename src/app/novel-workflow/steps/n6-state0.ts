import { StoryArchitecture } from "../../../novel-flow/architecture/types";
import { State0Agent } from "../../../novel-flow/state0";
import { State0 } from "../../../novel-flow/state0/types";
import { readLatestArchitecture, saveState0 } from "../artifacts";

export async function runN6Only(
  state0Agent: State0Agent,
  persist: boolean,
  architecture?: StoryArchitecture,
): Promise<State0> {
  let input: StoryArchitecture;
  if (architecture !== undefined) {
    input = architecture;
  } else {
    const latest = readLatestArchitecture();
    if (latest === null) {
      throw new Error("没有找到 N5 小说静态架构（artifacts/n5-architecture/），请先运行 --step n5 或全链路");
    }
    input = latest;
  }
  const result = await state0Agent.createState0(input);
  console.log(`\n【N6 State₀ 初始化运行状态】人物状态 ${result.characterStates.length} 条 / 关系状态 ${result.relationshipStates.length} 条 / 世界状态 ${result.worldState.length} 条 / 伏笔种子 ${result.hookSeeds.length} 条 / 线状态板 ${result.threadBoard.length} 条 / 进度`);
  console.log(JSON.stringify(result, null, 2));
  if (persist) {
    saveState0(result);
  }
  return result;
}

export async function runN6Step(
  state0Agent: State0Agent,
  persist: boolean,
  memoryArchitecture?: StoryArchitecture,
): Promise<void> {
  await runN6Only(state0Agent, persist, memoryArchitecture);
}
