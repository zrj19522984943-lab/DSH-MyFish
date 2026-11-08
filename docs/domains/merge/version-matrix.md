owner: merge.version-matrix
anchors: dsh-fish-qq/package.json; dsh-fish-qq/fish/package.json; dsh-fish-qq/qq/package.json
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0 / qq@0.1.18

# merge.version-matrix

本文档是 `merge.version-matrix` 的唯一事实来源：三个包的版本与 `package.json` 路径。**改版本只改这一处**（三个 `package.json` + 本表），其他文档只链接本表，不再写版本号。

## 版本表

| 包 | 版本 | package.json |
| --- | --- | --- |
| `dsh-fish-qq`（二合一包） | **2.0.0** | `dsh-fish-qq/package.json` |
| `dsh-fish`（大肥鱼子包） | **0.7.0** | `dsh-fish-qq/fish/package.json` |
| `dsh-qq-bridge`（QQ 桥接子包） | **0.1.18** | `dsh-fish-qq/qq/package.json` |

## 事实

- 版本号只从三个 `package.json` 读；本表是唯一汇总表。发版时改三个 `package.json` 的 `version`，再同步本表三行。
- 子包版本与合并包版本独立：`dsh-fish-qq@2.0.0` 内含 `dsh-fish@0.7.0` + `dsh-qq-bridge@0.1.18`。
- `dsh-fish-qq/index.js` 的 `VERSION='1.4.0'` 是**旧常量**，与 `package.json` 的 2.0.0 不一致；运行时日志可能打印 1.4.0。以 `package.json` 为准，发版时应同步该常量。
- `fish/lib/index.js` 的 `VERSION='0.7.0'` 与 `fish/package.json` 一致；QQ 子包没有单独的 `VERSION` 常量。
- 其他文档（README、对接、功能、ARCHIVE 头等）不再写具体版本号；需要版本时链接本表。
- `CHANGELOG.md` 是历史记录，允许保留历史版本号，不作为当前版本事实源。

## 不负责

- 版本变更记录 → 见 `dsh-qq-bridge__CHANGELOG.md`（归档，历史）。
- 包生命周期/依赖 → 见 `merge.lifecycle` / `merge.inject`。
- 发布包版本/打包 → 见 `ops.release`。
- 具体子包功能 → 见 fish/qq 各单元。

## 验收

```powershell
node -e "for (const p of ['dsh-fish-qq/package.json','dsh-fish-qq/fish/package.json','dsh-fish-qq/qq/package.json']) console.log(p, require('./'+p).version)"
```
应输出 `2.0.0` / `0.7.0` / `0.1.18`，与上表一致。
