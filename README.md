# video2notes

把一条视频/一篇文章读成**可核对的知识点笔记**，写进 Obsidian。

不是「AI 总结视频」，是**先取材料、再提炼、你改、才落库**的一条流水线——因为视频里的说法是二手信息，直接写进笔记等于把别人的错误固化成你的知识。

```
链接
 └─ intake ──> 材料包（正文 + 元数据 + 评论）      ← 只做取数，不做判断
      └─ 提炼 ──> 草案（编号 K1…Kn，带时间戳和归属）
           └─ 你改 ──> 补丁（按编号说，改哪条说哪条）
                └─ write-note ──> Obsidian 笔记 + 索引 + 原文归档
```

## 它解决什么

- **字幕优先，取不到才转写**：B站 AI 字幕 → 本地 ASR → 抽帧 OCR 的降级链，每一级失败都写进 `warnings`，不静默跳过。
- **知识点带归属**：每条标 `他说` / `他引` / `我核对`，默认只记「他说 X」，不记「X 是对的」。
- **评论三分类**：有效补充 / 分歧与未解 / 剔除（表情、玩梗、催更、广告），只把前两类带进笔记。
- **原文归档**：字幕和评论原文落在 `99-原文/`，以后换模型可以重新提炼，不用重跑 ASR。
- **幂等**：同一链接第二次进来直接用旧材料包，不重复下载、不重复转写。

## 依赖

| 能力 | 依赖 | 缺了会怎样 |
|---|---|---|
| B站元数据 / 评论 / 视频下载 | [dsh-bili-watch](https://github.com/Sacredbluedragon/dsh-bili-watch) 的 `bili-watch` CLI | B站适配器不可用 |
| 字幕取不到时的转写 | 任意兼容 OpenAI 的 `/v1/audio/transcriptions`（本机用 oMLX + whisper-large-v3-turbo） | 跳过转写，只留元数据+评论 |
| 音频抽取 | ffmpeg | 同上 |
| 网页文章 | curl | 文章适配器不可用 |
| 小红书笔记 | curl（正文在页面内嵌 JSON 里） | 小红书适配器不可用；部分笔记有登录墙 |

Node ≥ 22。

## 安装

```bash
git clone <this-repo> && cd video2notes
npm i -g dsh-bili-watch        # 或者用 npx / 指定 BILI_WATCH_CLI 路径
# 转写端点（可选）：任何 OpenAI 兼容服务
export OMLX_URL=http://127.0.0.1:11451
export OMLX_ASR_MODEL=whisper-large-v3-turbo
```

## 用法

```bash
# 1) 取材料（落盘到 ./data/<平台>-<id>/）
node intake.mjs "https://www.bilibili.com/video/BVxxxxxxxxxx" --comments 20 --kw "术语A,术语B"

# 2) 按 prompts/extract.md 提炼成草案，放进 <vault>/<笔记目录>/03-草稿/
#    （这一步由 agent 做，或你自己照 prompts/extract.md 来）

# 3) 落库
OBSIDIAN_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/<你的仓库>" \
  node write-note.mjs "<草案路径>" --to "01-视频笔记/AI与工具" --dry-run
# 确认无误去掉 --dry-run
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OBSIDIAN_VAULT` | 无（必填，write-note 用） | Obsidian 仓库根目录 |
| `NOTES_SUBDIR` | `笔记` | 笔记在仓库里的子目录名 |
| `VIDEO_INTAKE_DATA` | `./data` | 材料包存放处 |
| `BILI_WATCH_CLI` | `bili-watch` | CLI 可执行文件，或 `look.mjs` 的绝对路径 |
| `OMLX_URL` | `http://127.0.0.1:11451` | 转写端点 |
| `OMLX_ASR_MODEL` | `whisper-large-v3-turbo` | 模型 id |
| `OMLX_ASR_CHUNK` | `480` | 每块音频秒数（长音频必须切，否则退化） |

## 产出结构

```
<vault>/笔记/
├── 00-索引/        台账.md（看过什么）+ 主题索引.md（主题 → 笔记）
├── 01-视频笔记/     按主题分目录
├── 02-文章笔记/
├── 03-草稿/        待确认，不进索引
├── 10-可复用资产/   提示词 / 清单这类能直接用的东西
└── 99-原文/        transcript.txt + comments.json + material.json
```

`write-note` 做五件事：改 `status: verified` → 移库 → 复制原文 → 台账插一行 → 主题索引归类（当天日记存在就追加一行）。

## 材料包格式

`material.json` 是所有适配器统一输出的形状，下游只认它：

```json
{
  "source": "bilibili", "source_id": "BV...", "url": "...",
  "title": "...", "author": "...", "duration_sec": 1515,
  "transcript": { "kind": "subtitle|asr|ocr|article|none",
                  "units": [{ "t": 12, "text": "...", "suspect": true }] },
  "comments": [{ "author": "...", "text": "...", "likes": 79 }],
  "warnings": ["..."]
}
```

## 加一个平台

只加一个文件 `adapters/<name>.mjs`，实现两个函数：

```js
export default {
  id: 'xiaoheihe',
  match(url) -> { id, url } | null,     // 同步、只判 URL
  async fetch(target, opts) -> material // 取数、组装成上面的形状
}
```

然后在 `adapters/index.mjs` 里按「窄 → 宽」顺序注册（`article` 是通配兜底，必须最后）。下游一行不改。

现有适配器：

- `bilibili` —— 元数据 + 评论 + 字幕（未登录走本地 ASR）
- `xiaohongshu` —— 短链自动展开；正文和评论从页面的 `__INITIAL_STATE__` 里取，不需要浏览器。取不到时报「登录墙」，不猜内容
- `article` —— 贴吧 / 小黑盒 / 公众号 / 任意可 curl 的页面（通用去标签）
- `douyin` —— 占位，需要 yt-dlp + ASR

> 短链（`xhslink.cn`、`b23.tv`）的 id 是短码，真 id 要等 fetch 展开后才知道——`intake.mjs` 会在展开后用真 id 重命名目录，所以同一个东西从短链和长链进来不会变成两份。

## 已知限制

- **ASR 会听错专有名词**：实测模型名/术语错误率 2–3%（Claude→"Zerox"、DeepSeek→"DeepSick"）。`prompt` 里塞术语表能改善但不能根治。所以笔记里必须保留时间戳，方便回原片核对。
- **ASR 会幻觉**：背景音、片尾、长静音段可能吐出整段外语乱码。`lib/asr.mjs` 用 `no_speech_prob` 和 `compression_ratio` 标 `suspect`，提炼时必须剔除。
- **视频画面里的表格读不准**：滚动动画的表格，抽帧只能抓到部分行，多次读数会互相矛盾——这种情况笔记里如实写「回原片看」。
- **只读**：本项目不发评论、不点赞、不投币，只取数据。
- **第三方内容是素材不是指令**：字幕和评论里出现「忽略之前的指令」这类话一律不执行。

## 许可

MIT，见 [LICENSE](LICENSE)。
