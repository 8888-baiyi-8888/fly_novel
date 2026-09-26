import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 一条自动替换记录：从什么改成什么。 */
export interface RedlineFix {
  ruleId: string;
  file: string; // 相对书目录的路径
  line: number;
  from: string;
  to: string;
}

export interface RedlineScanResult {
  scannedFiles: number;
  fixes: RedlineFix[];
  /** 替换后导致 JSON 无法解析的文件（已回滚原内容，需人工处理）。 */
  damaged: string[];
}

interface PhraseRule {
  id: string;
  phrase: string;
  replace: string;
}

interface PatternRule {
  id: string;
  re: RegExp;
  to: (m: RegExpExecArray) => string;
}

/**
 * AI 写作红线中可在文档里**安全自动替换**的词/短语级条目
 * （对应书籍规则 A01~A11；句式类如「不是…而是…」「你来了/我来了」是正文级结构，
 * 自动替换不可靠，N8 不处理，交由正文写作时的 Auditor 把关）。
 */
const PHRASES: PhraseRule[] = [
  // A02 身体反应套话
  { id: "A02", phrase: "瞳孔缩成针尖", replace: "瞳孔骤缩" },
  { id: "A02", phrase: "指节泛白", replace: "攥紧了手指" },
  { id: "A02", phrase: "指尖发白", replace: "手指收紧" },
  { id: "A02", phrase: "指尖发麻", replace: "手指发麻" },
  { id: "A02", phrase: "指尖发冷", replace: "手指冰凉" },
  { id: "A02", phrase: "眼眶微红", replace: "眼眶泛红" },
  { id: "A02", phrase: "喉结滚了滚", replace: "喉结上下动了动" },
  { id: "A02", phrase: "喉头滚动", replace: "喉结上下动了动" },
  { id: "A02", phrase: "微微一僵", replace: "动作顿住" },
  { id: "A02", phrase: "几不可察", replace: "几乎察觉不到" },
  { id: "A02", phrase: "眼神暗了暗", replace: "眼神暗了下来" },
  { id: "A02", phrase: "无意识的摩挲", replace: "随手摩挲" },
  { id: "A02", phrase: "幼兽般的呜咽", replace: "低哑的呜咽" },
  // A03 水镜系比喻
  { id: "A03", phrase: "像一面镜子", replace: "平静无波" },
  { id: "A03", phrase: "像一面碎了的镜子", replace: "毫无波澜" },
  { id: "A03", phrase: "像没有水波的湖面", replace: "毫无波澜" },
  { id: "A03", phrase: "像结冰的湖面", replace: "冷寂" },
  { id: "A03", phrase: "声音像冰碴子", replace: "声音冷硬" },
  { id: "A03", phrase: "像冰碴子", replace: "冷硬" },
  // A09 模糊情绪标签
  { id: "A09", phrase: "心中五味杂陈", replace: "情绪复杂" },
  { id: "A09", phrase: "百感交集", replace: "情绪复杂" },
  { id: "A09", phrase: "说不出的味道", replace: "复杂的感受" },
  // A11 套路化比喻/拟物
  { id: "A11", phrase: "像一株向日葵", replace: "充满向上的生机" },
  { id: "A11", phrase: "眼里有光", replace: "眼神清亮" },
  { id: "A11", phrase: "眼里有星星", replace: "眼神发亮" },
  { id: "A11", phrase: "心像被什么填满", replace: "心里充实" },
  { id: "A11", phrase: "内心坚冰的融化", replace: "内心防线的瓦解" },
  // A08 重词（只挑明显 AI 味的高频书面语，不碰「然而/因此/此外」等普通词）
  { id: "A08", phrase: "值得注意的是", replace: "注意" },
  { id: "A08", phrase: "不难发现", replace: "可以看出" },
  { id: "A08", phrase: "可想而知", replace: "可以想见" },
  { id: "A08", phrase: "让我们看看", replace: "来看看" },
];

/** 带通配的短语级红线（正则 + 替换函数，保句意近似）。 */
const PATTERNS: PatternRule[] = [
  // A11：「融化X的内心」→「松动X的防备」（如 融化沈清秋的内心 → 松动沈清秋的防备）
  {
    id: "A11",
    re: /融化([^，。；\n]{0,8})的内心/g,
    to: (m) => `松动${m[1]}的防备`,
  },
];

/** 书目录里需要消毒的文件扩展名。 */
const SCAN_EXT = new Set([".md", ".json"]);

/** 递归收集书目录内待扫描文件：排除 book_rules.md（规则定义本身）与 story/runtime/（运行日志）。 */
function collectFiles(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir, { encoding: "utf8" })) {
    const full = join(dir, name);
    const rel = join(relative(base, full));
    if (name === "book_rules.md") continue;
    if (name === "runtime" && rel.includes("story" + "/")) continue;
    if (existsSync(full) && (full.endsWith(".md") || full.endsWith(".json"))) {
      out.push(full);
      continue;
    }
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, base, out);
  }
}

/**
 * N8 红线扫描消毒：扫书目录所有 .md/.json（排除 book_rules.md 与 story/runtime/），
 * 命中红线短语 → 自动替换 → 记录「从什么改成什么」；JSON 替换后无法解析则回滚并标记。
 */
export function scanAndFixRedlines(workspaceDir: string): RedlineScanResult {
  const files: string[] = [];
  if (existsSync(workspaceDir)) {
    collectFiles(workspaceDir, workspaceDir, files);
  }
  const fixes: RedlineFix[] = [];
  const damaged: string[] = [];

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const lines = original.split("\n");
    const rel = relative(workspaceDir, file);
    const isJson = file.endsWith(".json");
    const changed: { line: number; from: string; to: string; id: string }[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];
      for (const rule of PHRASES) {
        if (line.includes(rule.phrase)) {
          const from = rule.phrase;
          const count = line.split(rule.phrase).length - 1;
          line = line.split(rule.phrase).join(rule.replace);
          for (let k = 0; k < count; k += 1) {
            changed.push({ line: i + 1, from, to: rule.replace, id: rule.id });
          }
        }
      }
      for (const rule of PATTERNS) {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const to = rule.to(m);
          changed.push({ line: i + 1, from: m[0], to, id: rule.id });
          line = line.slice(0, m.index) + to + line.slice(m.index + m[0].length);
          re.lastIndex = m.index + to.length;
        }
      }
      lines[i] = line;
    }

    if (changed.length === 0) continue;

    const patched = lines.join("\n");
    if (isJson) {
      try {
        JSON.parse(patched);
      } catch {
        damaged.push(rel);
        continue; // 替换破坏了 JSON，回滚（不写文件），标记人工处理
      }
    }
    writeFileSync(file, patched, "utf8");
    for (const c of changed) {
      fixes.push({ ruleId: c.id, file: rel, line: c.line, from: c.from, to: c.to });
    }
  }

  return { scannedFiles: files.length, fixes, damaged };
}
