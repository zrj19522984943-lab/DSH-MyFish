owner: fish.readfile
anchors: dsh-fish-qq/fish/lib/readfile.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.readfile

本文档是 `fish.readfile` 的唯一事实来源：`fish_read_file` 工具的两份只读沙箱、大小/行数/字符上限、二进制判断与错误话术。

## 事实

- 工具名 `fish_read_file`；参数 `path`（必填）、`scope`（`workspace` 默认 / `self`）、`offset`、`limit`。
- **绝对只读**：只用 `readFileSync` / `statSync` / `realpathSync`；没有 write/unlink/rm/child_process。
- 两份沙箱：
  - `scope=workspace`：根是设置页「工作区根目录」或 `DSH_FISH_WORKSPACE`；
  - `scope=self`：根是 `~/.dsh-fish`，只放开 `SELF_ALLOW`：`events.jsonl`、`diary/`、`out/`、`home/`、`inbox.md`、`talk-recent.json`；`config.json` / `owner.json` / `logs/` 不可读。
- 路径校验顺序：`resolve` 归一（吃掉 `..`）→ 必须严格位于根之下 → `realpathSync.native`（解析 junction）再校验 → `stat` 必须是普通文件 → 大小/行数/字符封顶。任一步失败返回中文原因，**不抛**。
- 上限：`MAX_FILE_BYTES = 2 * 1024 * 1024`（2MB）；`DEFAULT_LINES = 400`；`MAX_LINES = 2000`；`MAX_CHARS = 24_000`。超过就如实说「太大/太长」，让她用 `offset` / `limit` 分段读。
- 二进制嗅探开头 `8192` 字节；编码认不出来时返回原因，不乱读。
- 回执带路径与行号范围；长文件不一次塞满上下文。

## 不负责

- 列目录 → `fish_list_dir`（见 `fish.tools` / `fish.work`）。
- 工作区根解析 → 见 `fish.tools` / `fish.settings`（T4 后设置并入 `fish.identity`/`merge` 相关单元，按 INDEX 路由）。
- 派活写文件 → 见 `fish.work`。
- 工具清单与三把刀 → 见 `fish.tools`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/readfile.test.mjs
```
重点断言：两份沙箱越界拒绝、`..`/绝对路径/ junction 解析、2MB/2000 行/24000 字上限、二进制拒绝、错误不抛。
