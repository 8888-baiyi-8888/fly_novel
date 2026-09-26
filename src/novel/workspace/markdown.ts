import { CharacterCard, Beat, VolumeMapItem, ThreadLine } from "../architecture/types";
import { BookRules } from "../architect/types";
import { HookSeed, ThreadBoardState } from "../state0/types";

/** 把内容行包成 Markdown 文档：一级标题 + 空行 + 各行。 */
export function mdDoc(title: string, lines: string[]): string {
  return [`# ${title}`, "", ...lines].join("\n");
}

/** 书籍规则 → md（书特定规则与 AI 红线分组）。 */
export function bookRulesToMd(rules: BookRules): string {
  const story = rules.rules.filter((r) => r.category === "story");
  const redlines = rules.rules.filter((r) => r.category === "ai-redline");
  const lines: string[] = [];
  lines.push(`## 书特定规则（${story.length} 条）`, "");
  for (const rule of story) {
    lines.push(`- **${rule.id}**：${rule.content}`);
  }
  lines.push("", `## AI 写作红线（${redlines.length} 条，正文一律禁用）`, "");
  for (const rule of redlines) {
    lines.push(`- **${rule.id}**：${rule.content}`);
  }
  return mdDoc(`书籍规则（${rules.title}）`, lines);
}

/** 故事圣经 → md。 */
export function storyBibleToMd(bible: { title: string; sections: { id: string; title: string; content: string }[] }): string {
  const lines: string[] = [];
  for (const section of bible.sections) {
    lines.push(`## ${section.id} ${section.title}`, "", section.content, "");
  }
  return mdDoc(`故事圣经（${bible.title}）`, lines);
}

/** 角色卡 → md（含分级 / 秘密 / 知识边界）。 */
export function charactersToMd(cards: CharacterCard[]): string {
  const lines: string[] = [];
  for (const card of cards) {
    lines.push(
      `## ${card.name}（${card.tier} 级 · ${card.archetype}）`,
      "",
      `- 性格特征：${card.traits.join("；")}`,
      `- 说话风格：${card.speechStyle}`,
      `- 自己知道别人不知道的（secret）：${card.secret}`,
      `- 绝不可能知道的知识边界：`,
    );
    for (const boundary of card.knowledgeBoundary) {
      lines.push(`  - ${boundary}`);
    }
    lines.push(`- 关系：`);
    for (const rel of card.relationships) {
      lines.push(`  - ${rel.name}：${rel.relation}`);
    }
    lines.push("");
  }
  return mdDoc("角色卡（Characters）", lines);
}

/** 伏笔账本 → md（人读表格；机器读权威在 state/hooks.json）。 */
export function hooksToMd(seeds: HookSeed[]): string {
  const lines: string[] = [
    "> 本文件是伏笔账本的人读投影，机器读权威见 state/hooks.json。",
    "> 每章写完后由 Settler 划账：状态 planned → open → resolved，还清的挪进 hooks_archive.md。",
    "",
    "| hookId | beatTag | 埋设章 | 类型 | 档位 | 核心 | 预期回收 | 埋设原文 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const seed of seeds) {
    const payoff = seed.expectedPayoff === null ? "未定" : `ch${seed.expectedPayoff}`;
    lines.push(
      `| ${seed.hookId} | ${seed.beatTag} | ch${seed.plantedChapter} | ${seed.type} | ${seed.timing} | ${seed.core || "-"} | ${payoff} | ${seed.notes || seed.payoffNote} |`,
    );
  }
  return mdDoc("伏笔账本（Hooks）", lines);
}

/** 叙事线 → md：逻辑层（事件链 + 前置 + 汇合）+ 调度层（当前状态板）。 */
export function threadsToMd(lines: ThreadLine[], board: ThreadBoardState[]): string {
  const out: string[] = [];
  for (const line of lines) {
    out.push(`## 线 ${line.id}：${line.name}`, "", `- 目标：${line.goal}`, `- 事件链：`);
    for (const event of line.events) {
      const merge = event.merge ? "（汇合事件）" : "";
      const requires = event.requires.length > 0 ? `　前置：${event.requires.join(" + ")}` : "";
      out.push(`  - ${event.id} ${event.content}${merge}${requires}`);
    }
    out.push("");
  }
  out.push("## 线状态板（调度层，初始 State₀）", "");
  out.push("| 线 | 状态 | 当前事件 | 下一事件 | 等待条件 | 预计唤醒 |", "|---|---|---|---|---|---|");
  for (const item of board) {
    out.push(
      `| ${item.lineId} | ${item.status} | ${item.currentEvent ?? "-"} | ${item.nextEvent ?? "-"} | ${item.waitingFor.join("；") || "-"} | ${item.estimatedWake} |`,
    );
  }
  return mdDoc("叙事线与状态板（Threads）", out);
}

/** 节拍板 → 按卷分组的人读投影；返回 "volume-01.md" → 内容 的映射。 */
export function beatsByVolumeToMd(volumeMap: VolumeMapItem[], beats: Beat[]): Record<string, string> {
  const result: Record<string, string> = {};
  volumeMap.forEach((volume, index) => {
    const volumeName = volume.volume;
    const lines: string[] = [`> ${volume.title}：${volume.goal}`, "", `> 阶段：${volume.stages.join(" → ")}`, ""];
    for (const beat of beats) {
      if (beat.chapter > 0 && beat.chapter > index * Math.ceil(beats.length / volumeMap.length) && beat.chapter <= (index + 1) * Math.ceil(beats.length / volumeMap.length)) {
        const hooks = beat.hookIntentions.length > 0 ? `　埋：${beat.hookIntentions.join("；")}` : "";
        const payoff = beat.plannedPayoffOf.length > 0 ? `　收：${beat.plannedPayoffOf.join("、")}` : "";
        lines.push(
          `### ch${beat.chapter} ${beat.title}`,
          "",
          `- ${beat.mainBeat}（${beat.pacing} · ${beat.emotionalArc}）`,
          `- 线：${beat.threadId}${hooks}${payoff}`,
          "",
        );
      }
    }
    result[`volume-${String(index + 1).padStart(2, "0")}.md`] = mdDoc(`${volumeName} ${volume.title}（节拍板投影）`, lines);
  });
  return result;
}
