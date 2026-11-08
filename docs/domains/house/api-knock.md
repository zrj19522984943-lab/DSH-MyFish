owner: house.api-knock
anchors: cyber_house/api-router.js#handleKnock
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-knock

本文档是 `house.api-knock` 的唯一事实来源：`POST /api/fish-home/knock` 的跨屏敲门契约。

## 事实

- 请求：`{"message":"我回来了"}`；从网页给小鱼的 DSH 会话留一句话。
- 校验：`message` 不能为空，最长 500 字；400 直接拒绝。
- 投递：`deliverKnock()` 找她的 fish 会话并投递；成功只回 `{ok:true}`（**不带 data**）；投递失败返回 502/其他，错误体有 `error`。
- 副作用：`engine.registerKnock(message)` 把「有人敲门」记为当前活动约 2 分钟；`GET /state` 在这段时间里 `room` 变为客厅附近、`activity='qq'`、`status='有人敲门'`，她会游到客厅。
- 与 QQ 入站无关：这是网页→她 DSH 会话的入口，不经过 OneBot/唤醒策略。

## 不负责

- QQ 入站/唤醒 → 见 `qq.wake` / `qq.onebot`。
- `/state` 的 `room/status/activity` 字段 → 见 `house.api.state`。
- DSH 会话发现/投递细节 → 见 `merge.lifecycle` / `ops.troubleshooting`。
- 前端按钮 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/knock -H "content-type: application/json" -d "{\"message\":\"我回来了\"}"
```
重点断言：空/超 500 字 400、成功 `{ok:true}` 无 data、2 分钟内活动变 qq、投递失败 502。
