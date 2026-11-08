owner: ops.troubleshooting
anchors: dsh-fish-qq/qq/index.js; README-RELEASE.md; cyber_house/api-router.js; pack-release.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# ops.troubleshooting

本文档是 `ops.troubleshooting` 的唯一事实来源：各文档「常见问题/排查入口」合并去重后的唯一表。安装步骤见 `ops.install`，验收见 `ops.acceptance`。

## 排查顺序

1. 先看 `qq_bridge_status`（设置/连接/目标会话/缓冲/最近日志/丢弃台账）。
2. 再看 DSH 日志与 `api-router.js` 控制台。
3. 最后才怀疑人格/模型；先确认「连接、白名单、目标会话、权限」四件事。

## 常见问题

| 症状 | 先查 | 处理 |
| --- | --- | --- |
| 插件列表没有 / 导入后起不来 | Node ≥22；选的是 `dsh-fish-qq` 文件夹；是否完全退出 DSH（含托盘） | 补 Node、重选文件夹、彻底重启；看 DSH 日志里的报错 |
| 侧栏没有「大肥鱼的家」 | `qq_bridge_status` 的 targetLoaded；`~/.dsh-fish/home.json`；DSH 是否重启 | 点一次「叫醒大肥鱼」；删坏 home.json 会重建；确认工作区根 |
| 设置页没有「大肥鱼」/「QQ 桥接」卡片 | `package.json` 的 `dsh.client`；是否重启 `dsh web` 并刷新页面 | 保留 client 声明；重启服务器 + F5；改 `client/` 后必须重建 |
| 8787 端口被占用 | 启动日志 / `netstat -ano` 里找 8787 | `$env:FISH_HOME_PORT=8790` 后重启后端 |
| `better-sqlite3` 编译失败 | Node 版本、Build Tools | 可忽略，Node 22+ 自动退 `node:sqlite`；或装 VS C++ 桌面开发后重装 |
| 网页 404 / 空白 | 后端是否在跑；访问的是 `http://127.0.0.1:8787/home_leaflet.html` 而非 `file://` | 起后端、换 URL |
| 小屋没有家具 | `cyber_house/furniture.json` 是否在；sqlite 是否被删 | 停后端 → 删 sqlite → 重启自动导入；或 `migrate.js --force` |
| QQ 私聊没反应 | `transport.state` 是否 `open`；`whitelist` 是否包含主人；`ownerQQ` 是否填；NapCat 端口/地址 | 修 onebotUrl/端口；把主人加白名单；完全重启 DSH |
| `help` 没反应 | 是否整条消息恰好是 `help`/`/help`/`帮助`/`指令`；发送者是否已通过白名单 | 改发精确指令；先加白名单；非主人只拿普通人那份 |
| 她说「这件事我做不到」 | 是否调了工具面外的工具；是否在 non-owner 轮 | 正常收窄；派活走 `work_request`；主人/管理员权限见 `qq.owner` |
| 任务日志没生成 | 任务那一轮是否结束；DSH 是否中途重启；`CheckLogs/` 是否可写 | 等结束；重启不补写；检查目录权限/`DSH_FISH_CHECKLOGS_DIR` |
| 文件读不到 | 路径是否在工作区根内；`scope=self` 是否白名单 | 改路径；self 只放开事件流/日记/报告/房间/inbox/talk-recent |
| 日记看不到 | `diary.visible` 是否 false | 打开可见性；默认只给日期 |
| 会话轮换后 QQ 没跟过去 | `targetSessionFromFish`；`home.json` 的 sessionId | 保持开关 true；确认 home.json 是新会话；第一条消息最多等 12 秒提要 |
| 主动私聊/私人时间不触发 | `proactiveEnabled` / `idleTriggerEnabled`；ownerQQ；空闲时长；每日上限 | 打开开关、配主人、等空闲；`force` 仍受上限 |
| 打包中止 | 暂存目录是否残留真实 Key/QQ/绝对路径 | 清理源文件后重跑；看 `pack-release.js` 的扫描报错 |
| 发布包内 README-RELEASE 缺失 | 是否误归档/改名 | 保持在仓库根；打包脚本按文件名读取 |
| 迁移后要素不对 | 是否 `--force` 重建过；旧 JSON 备份 | 看 `migrate.js --status`；从 `backups/legacy-json-*` 恢复 JSON 后 `--force` |

## 不负责

- 完整验收流程 → 见 `ops.acceptance`。
- 安装/配置 → 见 `ops.install` / `ops.config-write`。
- 各功能的正常行为 → 见对应 L1；本表只列「出问题时先看哪里」。
- 历史排查记录 → 见归档的 README/对接/功能文档与 CHANGELOG。

## 验收

```powershell
node scripts/docs-lint.mjs
```
人工核对：每条症状都能在 `ops.acceptance` 或对应 L1 找到「通过标准」；不把人格/模型当第一嫌疑。
