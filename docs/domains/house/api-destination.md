owner: house.api-destination
anchors: cyber_house/api-router.js#handleDestination; cyber_house/state-engine.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-destination

本文档是 `house.api-destination` 的唯一事实来源：`POST /api/fish-home/destination` 的规划/清除路线契约。

## 事实

- 规划：`{"x":500,"y":500}`；后端 `engine.setDestination(x,y)`，A* 规划 + 贝塞尔平滑；坐标钳回 0–1000，落在家具/墙上会贴到最近可走格。
- 成功：`{ok:true,data:{ok:true,destination:{x,y},route:[{x,y}],smoothPath:[{x,y}],pathStart:number|null,pathDuration:number}}`。
  - `route` 是剩余路径点（含脚下与终点；直线可达时可能为空）；
  - `smoothPath` 是前端 60 帧引擎消费的稠密点阵；
  - `pathStart` 是挂载时间戳；近在咫尺直接就位时 `null`；
  - `pathDuration` 总时长 ms。
- 清除：`{"clear":true}` → `engine.clearDestination()`，返回 `{ok:true,data:{ok:true,cleared:true}}`；让小鱼回到自然活动目标，不改家具/不打断活动。
- 错误：400 = 请求体不是 JSON 对象 / 缺 x/y / x/y 不是数字 / 坐标超出 -1000~2000；501 = 引擎没有规划能力。
- 平滑度默认 0.2，切进家具降 0.1，仍不安全退回直角折线（`smoothPath` 两点）；时间契约见 `house.motion`。

## 不负责

- 平滑/回退/`pathStart`/`pathDuration` 算法 → 见 `house.motion`。
- `/state` 的路线字段 → 见 `house.api.state`。
- A* 栅格/家具障碍 → 见 `house.pathfinder`。
- 校园经纬度路线（`setGeoDestination`）→ 见 `house.campus`。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/destination -H "content-type: application/json" -d "{\"x\":500,\"y\":500}"
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/destination -H "content-type: application/json" -d "{\"clear\":true}"
```
重点断言：x/y 钳制、route/smoothPath/pathStart/pathDuration、clear、400/501。
