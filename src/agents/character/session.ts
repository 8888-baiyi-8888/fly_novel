import type { BaseCheckpointSaver } from "@langchain/langgraph"
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite"
import type { CharacterAgentOptions } from "./types.js";
import { resolveCharacterAgentOptions } from "./utils.js";
import path from "node:path";
import { mkdirSync } from "node:fs";

export interface CheckpointerProvider {
  get(): BaseCheckpointSaver
}

export class CharacterSession implements CheckpointerProvider{
  private readonly checkpointer: SqliteSaver
	private readonly options: CharacterAgentOptions
	private readonly dbPath:string

  public constructor(
    options:CharacterAgentOptions
  ) {
		this.options = resolveCharacterAgentOptions(options)
		this.dbPath = path.join(
			this.options.basePath!,
			'novel_data',
			this.options.novelId,
			'session.sqlite'
		)
		mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.checkpointer =SqliteSaver.fromConnString(this.dbPath)
  }

  public get(): BaseCheckpointSaver {
    return this.checkpointer
  }
}