# fly_novel —— 小说级多 Agent 写作工作流

`fly_novel` 是一套「从一句话想法到完整小说正文」的自动写作系统。它分两个阶段：

- **阶段一 · 建书流**：把你的原始想法，一步步整理成一部完整小说的"蓝图"（人物、世界观、分卷、伏笔、节拍板、书目录）。
- **阶段二 · 章节流**：读取阶段一的成果，逐章写出正文，并自动结算每一章的伏笔推进。

下面从零开始教你怎么跑起来。

---

## 一、环境要求

- Node.js `v24.20.0`（或兼容版本）
- pnpm（`12.4.1` 及以上）

安装依赖（第一次）：

```bash
pnpm install
```

---

## 二、配置 API Key（重要，先做这一步）

系统调用大模型（当前用 **qwen/阿里云百炼**），你的 API Key 会**加密保存**，不会明文出现在文件或终端历史里。按顺序做：

### 第 1 步：生成加密密钥

```bash
pnpm run init-encryption-key
```

这会在 `.fly-novel/` 下生成 `.encryption-key`（本机专用，别删、别提交到仓库）。

### 第 2 步：加密你的 API Key

```bash
pnpm run credentials -- encrypt
```

- 运行后终端会提示"请输入 API Key"，粘贴你的百炼 API Key（输入时显示为圆点，回车确认）。
- 屏幕会输出一段**密文**（形如 `gcm2:...`）。它不会自动保存，**请复制**。

### 第 3 步：填两个配置文件

参照 `.fly-novel/settings.example.json`，打开并编辑：

**`.fly-novel/settings.json`** —— 供应商配置（把占位端点换成你的真实百炼兼容端点）：

```json
{
  "qwen": {
    "baseURL": "https://<你的百炼兼容端点>/compatible-mode/v1",
    "model": "qwen3.7-plus",
    "credentialRef": "QWEN_API_KEY",
    "responseFormat": "json_object"
  }
}
```

- `baseURL`：填你自己的阿里云百炼「兼容模式」端点。
- `credentialRef`：凭据名，必须和下面 `.credentials.json` 里的键一致。
- 如果你的模型名不同，把 `model` 换成实际模型名。

**`.fly-novel/.credentials.json`** —— 凭据密文（粘贴第 2 步复制的密文）：

```json
{
  "refs": {
    "QWEN_API_KEY": "这里粘贴第 2 步得到的密文"
  }
}
```

> 说明：系统**不读取 `.env` 明文**，只认这两个加密配置文件。设置好之后，下面所有命令都直接用，不需要再传 key。

---

## 三、构建 & 检查

```bash
pnpm run build        # 编译全部源码到 dist/（跑任何真实命令前先执行一次）
pnpm run typecheck    # 只做类型检查，不产构建产物
pnpm test             # 编译并运行全部测试（286 个）
```

> 你也可以用 `npx tsx src/app/main.ts ...` 免编译直接跑源码（首次会下载 tsx），效果相同。下面示例统一用编译后的 `node dist/...`。

---

## 四、阶段一：建书流（跑出整本书的蓝图）

### 最常用 —— 全链路一条命令跑完

```bash
node dist/app/main.js --model real --input "你的原始想法"
```

例如：

```bash
node dist/app/main.js --model real --input "题材是霸道女上司爱上初入职场的小白妹妹。不要太狗血，内容励志"
```

这会依次执行 **N0 → N1 → N2 →（N3 ‖ N4）→ N5 → N6 → N7 → N8**，每步产物自动落到 `artifacts/`。全程会调用真实模型多次，**耗时较长**，请耐心等待。

### 用文本文件作为输入

```bash
node dist/app/main.js --model real --file 想法.txt
```

### 加澄清交互（推荐第一次用）

加 `--clarify` 后，N1 会**反问你最多 3 轮问题**（书名、分卷、配角等），你回答后它再生成完整草案；回答到一半输入 `够了/停止/就这样` 可提前结束：

```bash
node dist/app/main.js --model real --input "你的想法" --clarify
```

### 只跑某个节点（断点续跑 / 单独看产物）

```bash
node dist/app/main.js --model real --step n0   # 只跑原始输入整理
node dist/app/main.js --model real --step n1   # 只跑创意草案
node dist/app/main.js --model real --step n3   # 只跑故事圣经+书籍规则
node dist/app/main.js --model real --step n4   # 只跑长期创作控制
node dist/app/main.js --model real --step n5   # 只跑节拍板（最耗时）
node dist/app/main.js --model real --step n6   # 只跑初始化运行状态 State0
node dist/app/main.js --step n2                # N2 纯程序，任何模式都能跑
node dist/app/main.js --step n7                # N7 纯程序，生成书目录
node dist/app/main.js --step n8                # N8 纯程序，验收+红线消毒
```

> 中途失败时，已经落盘的节点不用重跑——从失败的节点接着用 `--step` 续跑即可。N0 已有产物时，重跑会**跳过 N0**（打印"已存在 N0 产物"），要强制重新扩展就删除 `artifacts/n0-raw-input/` 下那个文件。

### 帮助

```bash
node dist/app/main.js --help
```

---

## 五、阶段二：章节流（写正文）

建书流跑完（`artifacts/n7-workspace/<bookId>/` 生成了书目录）之后，开始逐章写正文：

```bash
node dist/app/run-chapters.js                # 自动找最新书目录，写第 1 章
node dist/app/run-chapters.js --chapter 2    # 写第 2 章（自动延续上一章的伏笔状态）
node dist/app/run-chapters.js --chapter 1 --to 5   # 连续写第 1~5 章
node dist/app/run-chapters.js --book <bookId>      # 指定某本书
node dist/app/run-chapters.js --store-dir <dir>    # 正文/断点存放目录（默认 .fly-novel-store）
```

要点：

- **不传 `--to` 时只写 `--chapter` 指定的那 1 章**（默认第 1 章）。要写多章就加 `--to`。
- 每章结束自动把伏笔账本 / 支线调度 / 真相库 / 角色状态写进 `runtime-state.json`，下一章自动恢复——**跨章世界真实延续**。
- 某章失败或挂起时会停下来等你处理，处理好后重跑 `--chapter 该章` 即可，不污染后续。

---

## 六、产物都在哪

| 阶段 | 位置 | 内容 |
|---|---|---|
| 建书各节点 | `artifacts/n0-raw-input/` ~ `n6-state0/` | 原始输入、草案、书籍配置、故事圣经、控制、节拍板、状态 |
| 书目录 | `artifacts/n7-workspace/<bookId>/` | 章节流的输入（`inkos.json`、`state/hooks.json`、`story/beats/beats.json` 等） |
| 交接凭据 | `artifacts/`（N8 产物） | 验收结果 + 红线消毒记录 |
| 章节正文 | `.fly-novel-store/<bookId>/<章号>.md` | 每章写出的正文草稿 |
| 跨章运行态 | `.fly-novel-store/<bookId>/runtime-state.json` | 伏笔账本 / 支线 / 真相 / 角色状态（下一章延续） |
| 章断点 | `.fly-novel-store/<bookId>/<章号>.json` | 每章的 7 步产物与状态（可断点续跑） |

---

## 七、常见问题

- **提示"没有找到 N1 草案 / N7 书目录"**：说明对应的前序节点还没跑成功。先跑全链路或补跑对应 `--step`。
- **`--model real` 报缺供应商配置**：检查 `.fly-novel/settings.json` 是否填了 `qwen` 块，且 `credentialRef` 与 `.credentials.json` 的键一致。
- **`--credentials encrypt` 报"Encryption key is missing"**：先执行 `pnpm run init-encryption-key`。
- **建书流中途超时**：最常发生在 N5 节拍板（章节很多时）。会自动分块 + 自动修复；实在超时可以加大单块规模或用 `--step n5` 单独重跑。

---

## 本地工作区包（开发者）

相对导入支持 `.ts` 后缀，例如 `import { value } from './types.ts'`；编译时通过 `rewriteRelativeImportExtensions` 改写为 `.js`。公共包通过 `@fly-novel/llm`、`@fly-novel/util` 导入。编辑器与类型检查走源码映射；运行应用前执行 `pnpm run build`。
