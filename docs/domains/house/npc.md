owner: house.npc
anchors: cyber_house/gis/npcs.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.npc

本文档是 `house.npc` 的唯一事实来源：屋里两个 NPC（拟南芥 / 借手）的溜达、对白、气泡与 `events` 表写入。

## 事实

- 固定两位 NPC：🌱 **拟南芥**（书房，`#8fe388`）与 🐱 **借手**（客厅，`#ffb35c`）；`createNpcs(now, random)` 初始化位置/颜色/emoji。
- 每 5–10 分钟从 `cyber_house/npc_dialogue.json` 抽一段对白，写进 `cyber_house.sqlite` 的 `events` 表（`type=physical`? 实际是 NPC 事件类型；只追加），并给两位 NPC 挂气泡。
- `npcSnapshot(npc, now)` 返回 `{id,name,emoji,color,room,x,y,bubble}`；气泡过期自动 `null`；`GET /state` 的 `npcs` / `npcDialogue` 用它。
- NPC 各自在初始房间随机溜达，只走直线可通位置；不参与 A* 阻挡、不改家具。
- 小鱼用 `read_house_events` 工具自己翻最近事件，不需要系统每轮把闲话塞进上下文；工具实现见 `fish.house`（T4 后归 `fish.tools`/相关单元，按 INDEX 路由）。
- 对白台词来自 `cyber_house/npc_dialogue.json`；改台词不需要重启后端（下一段抽到时生效）。

## 不负责

- `/state` 的 `npcs`/`npcDialogue` 字段形状 → 见 `house.api.state`。
- 交互物块/敲门 → 见 `house.interaction`。
- fish 侧 `read_house_events` 工具 → 见 `fish.tools` / `fish.house`（若保留）。
- 前端气泡渲染 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
node cyber_house/.headless/npc-e2e.js
```
重点断言：两位 NPC、5–10 分钟对白、events 表写入、气泡过期、`state.npcs` 形状、不参与 A*。
