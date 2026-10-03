import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyWorkspace, scanAndFixRedlines } from "../../../novel-flow/workspace";
import { N7_WORKSPACE_DIR } from "../../../novel-flow/paths";

export function resolveWorkspaceBookId(bookIdArg?: string): { bookId: string; dir: string } {
  if (bookIdArg !== undefined && bookIdArg !== "") {
    return { bookId: bookIdArg, dir: join(N7_WORKSPACE_DIR, bookIdArg) };
  }
  mkdirSync(N7_WORKSPACE_DIR, { recursive: true });
  const books = readdirSync(N7_WORKSPACE_DIR, { encoding: "utf8" })
    .filter((name) => name !== ".gitkeep" && !name.startsWith("."))
    .sort();
  if (books.length === 0) {
    throw new Error(`artifacts/n7-workspace 下没有书目录，请先运行 --step n7。也可用 --book <bookId> 指定。`);
  }
  return { bookId: books[books.length - 1], dir: join(N7_WORKSPACE_DIR, books[books.length - 1]) };
}

export async function runN8Step(bookIdArg?: string): Promise<void> {
  const { bookId, dir } = resolveWorkspaceBookId(bookIdArg);
  if (!existsSync(dir)) {
    throw new Error(`书目录不存在：${dir}。请先运行 --step n7 生成，或检查 --book <bookId>。`);
  }
  console.log(`\n【N8 Book Runtime Ready】交接点：小说级终点 = 章节级起点`);
  console.log(`  书：${bookId} @ ${dir}\n`);
  const verify = verifyWorkspace(dir);
  for (const c of verify.checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  console.log(`\n【N8 红线消毒】扫描全部 .md/.json（排除 book_rules.md 规则定义与 story/runtime/ 运行日志）…`);
  const scan = scanAndFixRedlines(dir);
  if (scan.damaged.length > 0) {
    console.log(`  ⚠ 替换后 JSON 无法解析（已回滚，需人工处理）：${scan.damaged.join("、")}`);
  }
  if (scan.fixes.length === 0) {
    console.log("  未发现红线词，无需修改 ✓");
  } else {
    console.log(`  共 ${scan.fixes.length} 处自动替换（扫 ${scan.scannedFiles} 个文件）：`);
    for (const f of scan.fixes) {
      console.log(`    ${f.file}:${f.line}（${f.ruleId}）「${f.from}」→「${f.to}」`);
    }
  }
  const ready = {
    bookId,
    status: verify.ok && scan.damaged.length === 0 ? "ready" : "warn",
    checkedAt: new Date().toISOString(),
    checks: verify.checks,
    redlineFixes: scan.fixes,
    note: "N9 章节级工作流以此书目录为唯一事实源；Settler 划账等运行期更新只写本目录。",
  };
  const readyPath = join(dir, "story", "runtime", "ready.json");
  mkdirSync(join(dir, "story", "runtime"), { recursive: true });
  writeFileSync(readyPath, JSON.stringify(ready, null, 2), "utf8");
  console.log(`\n交接结果：${ready.status === "ready" ? "READY ✓（可进入 N9 章节执行）" : "WARN ⚠（存在缺失/损坏，请修复后再进 N9）"}`);
  console.log(`交接凭据已写入：${readyPath}`);
}
