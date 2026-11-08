owner: house.api-physical
anchors: cyber_house/hardware-sensor.js; cyber_house/telemetry/dsh-telemetry.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-physical

本文档是 `house.api-physical` 的唯一事实来源：物理环境感知的局域网延迟探测、事件队列与 `events` 表回看。手机电量接口归 `house.api-battery`。

## 事实

- **局域网延迟**：`hardware-sensor.js` 每 5 秒 ping 一次默认网关（拿不到网关用 `114.114.114.114`；`FISH_HOME_PING_HOST` 可指定）。
  - 延迟 > 500ms 触发；
  - 与上一次相比波动 > 300ms 触发；
  - 同类事件 5 分钟冷却，连续波动不重复注入。
- 事件链路：`engine.injectPhysicalEvent(text, meta)` → `cyber_house/physical_events/<timestamp>.json`（跨进程队列）+ `cyber_house.sqlite` 的 `events` 表（`type=physical`，可回看）。
- 事件正文示例：`[物理感知：局域网信号极其不稳定，可能有人走动机箱，或者网卡过载。]`
- **读走即删**：fish 每轮组装 system prompt 时读队列，读进正文后删除；30 分钟没被读走则过期删除。一次最多 4 条，避免刷屏。
- 手机插拔事件也走同一队列（见 `house.api-battery`）；fish 的 `fish:physical` 段只送事实，不预设反应。
- 服务启动时默认监听 `0.0.0.0`；`FISH_HOME_HOST=127.0.0.1` 可收回本机，同时关闭跨设备手机场景。

## 不负责

- 手机电量接口 → 见 `house.api-battery`。
- `fish:physical` 段的文本/生命周期 → 见 `fish.identity`。
- 环境/节奏传感器（`sensors/status.md` / `user_rhythm.md`）→ 见 `fish.senses`。
- 网络质量页面 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
node cyber_house/.headless/hardware-e2e.js
```
重点断言：5 秒探测、>500ms/波动 >300ms 触发、5 分钟冷却、事件队列读走即删、30 分钟 TTL、最多 4 条。
