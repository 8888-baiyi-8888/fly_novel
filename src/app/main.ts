import { readFileSync } from "node:fs";
import { MemoryModel } from "../harness/adapters/models/memory-model";
import { CreativeDraftAgent, CreativeDraftError } from "../novel/draft/creative-draft-agent";
import { EXAMPLE_DRAFT_JSON, EXAMPLE_RAW_INPUT } from "../novel/draft/example";

/**
 * 组装「创意草案整理」应用：使用内存模型（演示/测试）。
 * 生产环境接入真实模型时，替换 MemoryModel 为真实供应商适配器即可。
 */
export function buildCreativeDraftAgent(): CreativeDraftAgent {
  const model = new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } });
  return new CreativeDraftAgent({ model });
}

interface CliArgs {
  input?: string;
  file?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--input" && value !== undefined) {
      args.input = value;
      i += 1;
    } else if (token === "--file" && value !== undefined) {
      args.file = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${token}（支持 --input <文本> 或 --file <路径>）`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawInput = args.file !== undefined ? readFileSync(args.file, "utf8") : (args.input ?? EXAMPLE_RAW_INPUT);

  const agent = buildCreativeDraftAgent();
  const draft = await agent.createDraft(rawInput);
  console.log(JSON.stringify(draft, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof CreativeDraftError || error instanceof Error ? error.message : String(error);
  console.error(`创意草案整理失败：${message}`);
  process.exitCode = 1;
});
