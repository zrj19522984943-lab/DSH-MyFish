owner: ops.acceptance
anchors: README-RELEASE.md; packaging/setup.js; cyber_house/api-router.js; dsh-fish-qq/qq/index.js; dsh-fish-qq/index.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# ops.acceptance

本文档是 `ops.acceptance` 的唯一事实来源：合并 `README-RELEASE.md` §8、`qq/README.md` 验收条目、`功能文档.md` §10 后的唯一验收表，按「装 / 跑 / QQ / fish / house / 发布」分组，已去重。

## 装

| # | 检查 | 通过标准 |
| --- | --- | --- |
| A1 | `node -v` | ≥ v22 |
| A2 | 解压目录 `npm install` | 出现 `node_modules`，无红色 ERR（better-sqlite3 失败可忽略） |
| A3 | `config.json` | `qq.ownerQQ` / `qq.whitelist` 已填；`qq.qqNumber` 不接 QQ 可留占位 |
| A4 | `node setup.js` | 打印 `✔ 配置已写入`；`--dry-run` 不落盘 |
| A5 | DSH 插件中心导入 `dsh-fish-qq` 文件夹 | 列表出现 `dsh-fish-qq`，并完全重启过 DSH |
| A6 | 设置 → 插件 | 同时有「大肥鱼」与「QQ 桥接」两张卡片 |

## 跑

| # | 检查 | 通过标准 |
| --- | --- | --- |
| B1 | `node cyber_house/api-router.js` | 打印 API / 看板 / 局域网地址，无报错 |
| B2 | `http://127.0.0.1:8787/health` | `ok:true`、`featureCount:21`、`storage.schemaVersion:"1"` |
| B3 | `http://127.0.0.1:8787/home_leaflet.html` | 能看到小屋、小鱼、家具 |
| B4 | 重启 DSH 看侧栏 | 「大肥鱼的家」+「跟大肥鱼说话」 |
| B5 | 空状态库首次启动 | 从「信任」阶段开始；没有日记/记忆是正常的 |

## QQ

| # | 检查 | 通过标准 |
| --- | --- | --- |
| C1 | `qq_bridge_status` | `transport.state='open'`，`selfId` 正确，目标会话已加载 |
| C2 | 主人私聊「在吗」 | QQ 收到回复；不是 DSH 界面轮 |
| C3 | 主人私聊 `help` | 立刻收到指令列表，无模型耗时 |
| C4 | 非主人私聊 `help` | 不返回主人列表；按普通聊天处理 |
| C5 | 空 `whitelist` 发消息 | fail-closed，不唤醒 |
| C6 | 主人发 `whitelist <QQ>` | 立刻回确认，下一条消息生效 |
| C7 | 主人/管理员发 `receive` / `list` | 直回收件箱/目录清单，不叫模型 |
| C8 | 主人发 `subsend <QQ> <内容>` | 指定号收到私聊；超限/冷却如实报 |
| C9 | 主人/管理员发 `fileget` / `filesend` | 工作区内文件私聊发出；>50MB/越界被拒 |
| C10 | `checklogNotifyMode='off'` | 任务完成不发 QQ；改 system/agent 后才发 |
| C11 | `proactiveEnabled=false` | `qq_bridge_proactive force` 返回 `disabled`，无消息 |
| C12 | `idleTriggerEnabled=false` | 私人时间不扫描、不注入 |

## fish

| # | 检查 | 通过标准 |
| --- | --- | --- |
| D1 | 身份/成长 | 设置页能看到天数/阶段/瓶颈；`growth_commit` 能写事件 |
| D2 | `fish_search_history` / `fish_read_raw` | 只给摘要+seq_id；按门牌号能回原文 |
| D3 | `fish_read_file` scope=self 读 `config.json` | 被拒并说明原因 |
| D4 | `fish_now` | 日期/星期/时间与机器一致，带 UTC 偏移 |
| D5 | `check_body` / `read_user_rhythm` | 读 `sensors/status.md` / `user_rhythm.md`，旧了会说明 |
| D6 | `work_request` 派活 | 侧栏出现「工作·…」；结束后 `CheckLogs/` 多一个 `.md` |
| D7 | 换会话 | 新房间第一条带 `fish:handoff` 提要；8 轮/3 天后消失 |
| D8 | 桌宠输入窗（可选） | 透明置顶小窗能发一句话并显示返回；`DSH_FISH_PET=0` 可关 |

## house

| # | 检查 | 通过标准 |
| --- | --- | --- |
| E1 | `GET /api/fish-home/state` | 33 个字段齐全；无路线时 `smoothPath=[]`、`pathStart=null`、`pathDuration=0` |
| E2 | 网页画墙/家具 | 保存后 A* 栅格刷新，小鱼绕路 |
| E3 | 上传 SHP / QGIS 导入 | `uploaded_shp` / `map_level` 正确；重传同 id 覆盖 |
| E4 | 缓冲区分析 | 返回 64 边形与 ≤60 条命中 |
| E5 | 敲门 | 2 分钟内 `activity='qq'`、`status='有人敲门'` |
| E6 | 校园模式 | 切武大后 `environment='campus'`、`campusPoi` 非空、GCJ02 坐标可贴图 |
| E7 | 手机电量 | plug_in/unplug 去重；`phone_battery.json` 落盘；3 分钟内才显示 |
| E8 | 局域网延迟 | >500ms 或波动 >300ms 注入事件；5 分钟冷却 |

## 发布

| # | 检查 | 通过标准 |
| --- | --- | --- |
| F1 | `node pack-release.js` | 生成 `DSH-MyFish-Release.zip`，退出码 0 |
| F2 | 发布包内容 | 含 `README-RELEASE.md` / `config.example.json` / `setup.js` / `dsh-fish-qq/` / `cyber_house/` |
| F3 | 脱敏 | 无真实 API Key / QQ 号 / Cookie / 本机绝对路径 |
| F4 | 剔除 | 无 `cyber_house.sqlite`、`*.log`、`interaction-outbox.jsonl`、`backups/`、`node_modules/` |
| F5 | 发布包内 README-RELEASE.md | 内容完整（打包脚本按文件名读取，未归档） |

> 本表是三份旧验收清单（README-RELEASE §8、qq README 验收条目、功能文档 §10）合并去重后的唯一表；旧三处已改为 `见 [ops.acceptance]`。

## 不负责

- 安装步骤/前置 → 见 `ops.install`。
- 失败时怎么查 → 见 `ops.troubleshooting`。
- 打包实现 → 见 `ops.release`。
- 各功能的内部行为 → 见对应 L1（fish/qq/house 域）。

## 验收

按 A1–F5 逐项打勾；本表自身由 `node scripts/docs-lint.mjs` 的 L1/L6/L7/L8 检查结构。
