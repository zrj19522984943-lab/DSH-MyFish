owner: house.api-battery
anchors: cyber_house/api-router.js#handlePhoneBattery; cyber_house/hardware-sensor.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-battery

本文档是 `house.api-battery` 的唯一事实来源：手机电量上报接口 `GET/POST /api/fish-home/hardware/battery`。

## 事实

- `POST` body：`{action:'plug_in'|'unplug'|'update', level:0–1 或 0–100, charging?:boolean}`；`level` 兼容两种刻度，内部归一成 0–1 并给 `percent`。
- 行为：
  - `plug_in`：`plugged=true`、`charging=true`、覆盖电量；**第一次**插上才注入 `[物理感知：主人的手机插上了电脑…]`，重复 plug_in 去重；
  - `unplug`：`plugged=false`、`charging=false`、覆盖电量；**第一次**拔下才注入，重复去重；
  - `update`：静默覆盖电量/charging，**不注入**。
- 响应：`{ok:true,data:{action,injected,battery:{level,percent,charging,plugged,updatedAt,updatedAtMs,source}}}`；`GET` 返回同样的 `data.battery`。
- 最新值落盘 `cyber_house/phone_battery.json`；服务重启用 `hydratePhoneBattery()` 接着用上次的电量。
- fish 的 `fish:physical` 段只在「插着且 3 分钟内更新过」时显示电量行；超时不显示。
- `navigator.getBattery()` 需要安全上下文；局域网 HTTP 下部分浏览器不暴露，页面会提示，但接口可用 `curl` 验收。

## 不负责

- 局域网延迟探测/事件队列 → 见 `house.api-physical`。
- fish 侧 `fish:physical` 段的读取/注入 → 见 `fish.identity`。
- 前端手机看板 → 见 house 前端文件（T4 未单列）。
- 传感器采集脚本 → 见 `ops` 相关单元。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/hardware/battery -H "content-type: application/json" -d "{\"action\":\"plug_in\",\"level\":0.85,\"charging\":true}"
curl.exe http://127.0.0.1:8787/api/fish-home/hardware/battery
```
重点断言：两种刻度、重复 plug_in/unplug 去重、update 不注入、落盘/重启恢复、3 分钟新鲜度。
