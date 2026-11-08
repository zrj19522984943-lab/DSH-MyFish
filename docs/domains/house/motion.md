owner: house.motion
anchors: cyber_house/gis/pathfinder.js#smoothPathWithCubicBezier; cyber_house/gis/pathfinder.js#smoothPathWithFallback; cyber_house/gis/pathfinder.js#planSmoothRoute; cyber_house/gis/pathfinder.js#BEZIER_SAMPLES; cyber_house/state-engine.js#FISH_PATH_SPEED; cyber_house/state-engine.js#easeInOut; cyber_house/state-engine.js#_startPathTo; cyber_house/state-engine.js#getState
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.motion

本文档是 `house.motion` 的唯一事实来源：A* 折线怎么变成稠密贝塞尔点阵、怎么做穿模校验与回退、`pathStart` / `pathDuration` 怎么算，以及前端 60 帧采样的契约。`/state` 的完整字段表归 `house.api.state`。

## 事实

### 平滑：`smoothPathWithCubicBezier(points, smoothness = 0.2)`

- 输入是 A* 的直角折线锚点；非数组返回 `[]`，少于 2 个点原样返回。
- 先把点转成 `{x,y}` 并过滤非有限值；有效锚点少于 2 个时原样返回。
- `smoothness` 夹在 `0–0.45`（`ratio`）；`ratio <= 0` 直接返回锚点。
- 每个锚点的切向量：
  - 起点取「起点 → 下一点」的边；
  - 终点取「上一点 → 终点」的边；
  - 中间点取「上一点 → 下一点」的弦（局部切线）。
- 每段用三次贝塞尔：`CP1 = start + tangentStart * ratio`，`CP2 = end - tangentEnd * ratio`；从 `t = 1/14` 采到 `t = 1`，每段 **14 个采样点**（`BEZIER_SAMPLES = 14`），跳过 `t = 0` 避免锚点重复。
- 输出是 `1 + 14 × 段数` 个点的稠密点阵（首尾锚点精确保留）。

### 安全校验：`smoothPathIsSafe(dense, passable, obstacles)`

- 第一个锚点（小鱼脚下）**不参与校验**：它是既成事实，不是曲线造成的。
- 每个插值点必须同时满足：
  1. 落在 A* 可通行栅格内（`isPassablePoint`；栅格编码房间、门洞、家具格、自建墙/房间）；
  2. 不压在任何家具矩形上（`furnitureObstacles` 的 `cx/cy/w/h` 点级判定；栅格只按格心判，角落可能伸进可通行格）。
- 任一点不满足 → `false`。

### 回退：`smoothPathWithFallback(anchors, passable, obstacles, smoothness = 0.2)`

1. 先用默认 `0.2` 平滑并校验；安全 → 返回 `{ points, smoothness: 0.2 }`。
2. 不安全 → 降到 `min(smoothness, 0.1)` 再平滑校验；安全 → 返回 `{ points, smoothness: 0.1 }`。
3. 仍不安全 → 返回原始 A* 直角折线 `{ points: anchors.slice(), smoothness: 0 }`。

宁可直角急转，也不穿模卡进沙发。

### 一步到位：`planSmoothRoute(furniture, rooms, roomsByName, fromX, fromY, toX, toY, options)`

- `options` 可复用主引擎缓存的 `passable` / `obstacles` / `doors`，避免重复栅格化。
- 先 `planRoute()` 得到 A* 折线（直线可达时 `waypoints` 为 `null`）；锚点 = `[{fromX,fromY}] + (waypoints || [{toX,toY}])`。
- 再 `smoothPathWithFallback()` 得到 `smoothPath: { points, smoothness }`。
- 返回 `{ waypoints, anchors, smoothPath }`。

### 时间契约：`pathStart` / `pathDuration` / 位置

`state-engine.js`：

- `FISH_PATH_SPEED = 110` 世界单位/秒。
- `_startPathTo(toX, toY, kind, nowMs)`：规划 `smoothPath`，算累计弧长 `cum` 与总长 `total`，保存
  `{ points, cum, total, startedAt: nowMs, duration: (total / FISH_PATH_SPEED) * 1000, target, kind }`。
- `_samplePath(nowMs)`：`t = clamp((max(nowMs, startedAt) - startedAt) / duration, 0, 1)`，`distance = easeInOut(t) * total`，按累计弧长取点；到终点时返回 `{ done: true }`。
- `easeInOut(t)`：`t < 0.5 ? 2t² : 1 - (-2t+2)² / 2`；起步加速、停靠减速，长路线走 S 型弧线。
- `/state` 里：`smoothPath` 是点阵（无路线 `[]`）、`pathStart` 是 `startedAt`（无路线 `null`）、`pathDuration` 是 `duration`（无路线 `0`）。
- 速度契约：平均 110 单位/秒；峰值 220（缓动中点导数 = 2）。
- 前端用 `requestAnimationFrame` 按 `t = (now - pathStart) / pathDuration` 与同款 `easeInOut` 每帧采样，渲染帧率与 2 秒轮询解耦；`currentRoute` 是剩余未走弧长的点阵，用于收缩导航虚线。

### 已知偏差

- **`pathStart` / `pathDuration` 不在 `api-router.js`**：T3 初始 anchors 写的是 `api-router.js`；代码里这两个字段由 `state-engine.getState()` 组装，`api-router.js` 只负责 `sendJson({ ok:true, data: engine.getState() })`。本 L1 的 anchors 已按代码改成 `state-engine.js#getState`。
- **`smoothPath` 的采样数**：`API.md` §1 只写「稠密三次贝塞尔点阵：1 + 14×段数 个」，与代码 `BEZIER_SAMPLES = 14` 一致；代码没有把 `BEZIER_SAMPLES` 暴露到接口，前端不应依赖具体数字，只应消费点阵。
- **`pathDuration` 的「缩短」**：API.md 说「退回直角折线（`pathDuration` 同步缩短）」。代码 `duration` 只由 `total / FISH_PATH_SPEED` 算；退回直角折线时 `total` 通常比平滑曲线短，所以 duration 会变小，但没有额外系数。这是同一件事，不是两条规则。
- **速度 220 的来源**：代码没有单独的「峰值」常量；220 是 `110 × easeInOut'(0.5)`（缓动中点导数 2）的结果。改 `FISH_PATH_SPEED` 时峰值会同步变。

## 不负责

- `/state` 的完整字段、`map_level`、`campus` 语义 → 见 `house.api.state`。
- A* 的栅格构建、房间/门洞/家具的几何来源 → 见 `house.furniture` / `house.db-schema`。
- 前端 Leaflet 渲染与 60 帧播放代码 → 见 `house.editor`。
- 路线目的地接口（`POST /destination`）的业务语义 → 见 `house.server` / T4 端点单元。
- 交互物块触发与 NPC 移动 → 见 `house.interact` / `house.npc`。

## 验收

```powershell
# 不依赖服务的平滑/回退测试
node cyber_house/.headless/motion-test.js

# 需要服务在跑：验证 position = f(now - pathStart) 契约
node cyber_house/api-router.js   # 另一个窗口
node cyber_house/.headless/speed-test.js
```

人工核对：`smoothPathWithCubicBezier([{x:0,y:0},{x:100,y:0}])` 返回 15 个点（1 + 14）；不安全曲线先降 0.1、再退回直角折线；`/state` 无路线时三件套是 `[]` / `null` / `0`。
