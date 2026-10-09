import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAndFixRedlines, verifyWorkspace } from "../../../novel-flow/workspace";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 验收书籍工作空间并写入章节流交接凭据。 */
export function runReady(
  state: Pick<NovelWorkflowState, "workspace">,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
): Partial<NovelWorkflowState> {
  if (!persist) return {};
  const workspace = state.workspace;
  if (workspace === undefined) {
    throw new Error("缺少 workspace 节点产物，无法验收书籍工作空间");
  }

  const verify = verifyWorkspace(workspace.workspaceDir);
  const scan = scanAndFixRedlines(workspace.workspaceDir);
  const ready = {
    bookId: workspace.bookId,
    status: verify.ok && scan.damaged.length === 0 ? "ready" as const : "warn" as const,
    checkedAt: new Date().toISOString(),
    checks: verify.checks,
    redlineFixes: scan.fixes,
    note: "N9 章节级工作流以此书目录为唯一事实源；Settler 划账等运行期更新只写本目录。",
  };
  const runtimeDir = join(workspace.workspaceDir, "story", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "ready.json"), JSON.stringify(ready, null, 2), "utf8");
  artifacts.saveReady(ready, novelId);
  return { ready };
}
