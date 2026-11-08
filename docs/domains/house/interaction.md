owner: house.interaction
anchors: cyber_house/gis/interactions.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.interaction

本文档是 `house.interaction` 的唯一事实来源：`interact_text` 场景交互物块的触发/重置、气泡、outbox 与敲门活动。NPC 归 `house.npc`。

## 事实

- 任意要素 `properties.interact_text`（≤200 字）即成为交互物块；`type` 仍是 furniture/wall/room/custom。
- 触发：小鱼与几何本体距离 **< 30 世界单位**触发一次；离开到 **> 50** 才重置，回来可再次触发。
- 触发时：
  - `GET /state` 的 `interactionBubbles` 返回气泡（`{id,name,text,center,at,expiresAt}`，约 9 秒）；
  - 往 `<工作区>/cyber_house/interaction-outbox.jsonl` 追加 `[系统：小鱼碰到了{名称}，触发对话：“{文本}”]`；
  - QQ 桥接每秒消费该队列，私聊发给主人（`qq.ledger` / `qq.outbound` 的出站台账）。
- `interactions` 统计 `{triggered,reset,lastAt}`；`stepInteractionState` 纯函数按当前空间快照更新。
- 敲门：`registerKnock(message)` 后约 2 分钟，`room` 变为客厅附近、`activity='qq'`、`status='有人敲门'`；接口见 `house.api-knock`。
- 交互只依赖要素几何与 `interact_text`，不改盘面；上传 SHP 的 `shp_feature` 也能有 `interact_text`，但不会进 A*。

## 不负责

- `/state` 的 `interactionBubbles`/`interactions` 字段 → 见 `house.api.state`。
- 敲门 HTTP 接口 → 见 `house.api-knock`。
- 要素属性编辑/删除 → 见 `house.api-features`。
- QQ 出站台账 → 见 `qq.outbound` / `qq.state-file`。

## 验收

```powershell
node cyber_house/.headless/interaction-e2e.js
```
重点断言：30 单位触发、50 单位重置、气泡约 9 秒、outbox 追加、`interactions` 计数、敲门 2 分钟活动。
