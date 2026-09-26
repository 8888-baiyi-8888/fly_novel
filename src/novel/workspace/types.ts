/**
 * novel/workspace：持久化工作空间（Persistent Workspace，N7）。
 * 纯程序节点（不调 LLM）：把 N1~N6 全部产物序列化成书籍项目目录。
 * 静态知识 + 动态状态 + 创作控制 + 长期记忆全部落盘；
 * 人读 Markdown（story/*.md）与机器读 JSON（state/*.json）同一数据两种投影。
 */

/** N7 需要的全部输入（N1~N6 产物快照）。 */
export interface WorkspaceInputs {
  draft: import("../draft/types").CreativeDraft;
  bookConfig: import("../book-config/types").BookConfig;
  storyBible: import("../architect/types").StoryBible;
  bookRules: import("../architect/types").BookRules;
  controls: import("../controls/types").LongTermControls;
  architecture: import("../architecture/types").StoryArchitecture;
  state0: import("../state0/types").State0;
}

/** 一个待写文件的抽象（dry-run 与真实写入共用）。 */
export interface WorkspaceFile {
  /** 相对书目录的路径，如 "story/hooks.md"。 */
  relPath: string;
  content: string;
}

/** N7 运行结果。 */
export interface BuildWorkspaceResult {
  bookId: string;
  /** 书目录绝对路径。 */
  workspaceDir: string;
  /** true = 目录已存在且未传 force，跳过未写。 */
  skipped: boolean;
  /** 实际写出的文件相对路径列表（skipped 时为空）。 */
  filesWritten: string[];
}
