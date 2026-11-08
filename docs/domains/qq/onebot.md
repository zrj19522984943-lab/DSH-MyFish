owner: qq.onebot
anchors: dsh-fish-qq/qq/onebot.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.onebot

本文档是 `qq.onebot` 的唯一事实来源：OneBot v11 正向 WebSocket 客户端、重连/心跳、入站映射、出站 action 与防回环。NapCat 托管归 `qq.napcat`。

## 事实

- `createOneBotTransport(options)`：**用 Node 内置全局 WebSocket**（Node ≥22），不依赖 `ws`；只支持**正向** WS（插件作为客户端连 NapCat）。
- 连接：地址 `onebotUrl`；`access_token` 走**查询串**（WHATWG WebSocket 不支持自定义请求头）；连接状态 `idle|connecting|open|closed|reconnecting|disabled`。
- 重连：指数退避 `reconnectMinMs=1000` → `reconnectMaxMs=30000`，带 jitter；`heartbeatTimeoutMs`（默认 90000）内没有任何流量就判定死链并重连；心跳检查 tick 为 `max(5000, timeout/3)`。
- 入站映射：`message` 支持 array 与 string（CQ 码）两种形态；`at` 段 / `[CQ:at,qq=…]` 判 @；`post_type=message_sent` 与 `user_id===selfId` 直接忽略（防回环）；`notice` 目前适配戳一戳；`meta_event` 只观察连接健康。
- 出站：`send_private_msg` / `send_group_msg` / `upload_private_file` 等通过 `call(action, params)`，`echo` 配对回包；失败不抛到调用方。
- 状态：`status()` 暴露 state/url/selfId/connectedAt/lastError/reconnects/received/sent/pendingCalls/lastTrafficAt/reconnectDelayMs。
- `selfId` 空时连上后 `get_login_info` 自动取；token 每建连重新解析（不缓存）。

## 不负责

- 唤醒策略/白名单 → 见 `qq.wake` / `qq.safety`。
- 出站内容/长度/闸门 → 见 `qq.outbound`。
- 消息段拼装 → 见 `qq.outbound` / `qq.fileget`。
- NapCat 下载/启停 → 见 `qq.napcat`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-onebot.mjs
```
重点断言：内置 WS、array/string 两种入站、@ 识别、防回环、重连退避、心跳看门狗、token 查询串、send action 的 echo 配对。
