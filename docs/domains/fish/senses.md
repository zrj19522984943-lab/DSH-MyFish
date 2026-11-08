owner: fish.senses
anchors: dsh-fish-qq/fish/lib/body.js; dsh-fish-qq/fish/lib/rhythm.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.senses

本文档是 `fish.senses` 的唯一事实来源：赛博感官的两个只读工具（`check_body` / `read_user_rhythm`）与心跳采样器。数据采集脚本本身归 `ops`/`house` 的传感器单元。

## 事实

- **`check_body`（`body.js`）**：只读 `<工作区>/sensors/status.md`；文件不存在/不是普通文件/读不了都返回 `ok:false` + 原因。`BODY_STALE_MS = 60 * 60 * 1000`；超过 1 小时在回执里标「可能旧了」，不编数据。
- **`read_user_rhythm`（`rhythm.js`）**：只读 `<工作区>/sensors/user_rhythm.md`；`RHYTHM_STALE_MS = 60 * 60 * 1000`；按小时聚合成一行（如 `09:00-10:00 高频打字`），带更新时间。
- **采样器**：`startRhythmSampler({ workspaceRoot })` 每 5 分钟 spawn 一次 `<工作区>/pipeline/update_rhythm.js`；工作区没配/脚本不在只记日志，不影响插件；停用插件时随 `dispose` 收掉。
- 两个工具都**只读**，不注入常驻提示词；她需要时自己调。`identity.js` 的 `fish:senses` 段只写「有这些工具」的静态引导，不写数据本身。
- 工具名与 `FISH_TOOLS` 一致：`check_body`、`read_user_rhythm`。

## 不负责

- `sensors/status.md` / `user_rhythm.md` 的采集逻辑（环境传感器、节奏脚本）→ 见 `house.api-physical` / `ops` 相关单元。
- 身份段 `fish:senses` 的挂载 → 见 `fish.identity`。
- 工具清单与三把刀 → 见 `fish.tools`。
- 日程/叫醒 → 见 `fish.scheduler`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/body.test.mjs test/rhythm.test.mjs
```
重点断言：只读、1 小时过期标记、文件缺失原因、按小时聚合、采样器 5 分钟间隔、失败不抛。
