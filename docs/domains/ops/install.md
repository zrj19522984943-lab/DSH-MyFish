owner: ops.install
anchors: README-RELEASE.md; packaging/setup.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# ops.install

本文档是 `ops.install` 的唯一事实来源：纯净版从解压到跑起来的五步安装与前置要求。配置写入细节归 `ops.config-write`，验收归 `ops.acceptance`。

## 事实

- 前置：Windows 10/11（其他平台可跑但未验证）；Node.js ≥22（推荐 24）；DSH 桌面端 0.2.x；自己的 DeepSeek API Key（填在 DSH 设置里，不写插件目录）；可选 QQ 小号 + NapCat。
- 第 1 步：解压 `DSH-MyFish-Release.zip`；不要在压缩包里直接跑 node。
- 第 2 步：在解压目录 `npm install`；运行依赖 `@turf/turf` 与 `better-sqlite3`（编译失败可忽略，Node 22+ 退 `node:sqlite`）。
- 第 3 步：复制 `config.example.json` → `config.json`，填 `qq.ownerQQ` / `qq.qqNumber` / `qq.whitelist` / `qq.onebotUrl` / `qq.envWeatherCity`，执行 `node setup.js`；详见 `ops.config-write`。
- 第 4 步：DSH → 插件中心 → 从本地导入插件 → 选 `dsh-fish-qq` **文件夹**；完全退出 DSH（含托盘）再打开。
- 第 5 步：另开 PowerShell，`node cyber_house/api-router.js`；打开 `http://127.0.0.1:8787/home_leaflet.html`；`/health` 应 `ok:true`、`featureCount:21`。
- 可选 QQ：NapCat 登录小号 → 正向 WebSocket 端口 3001 → 设置卡片填 `onebotUrl` / `ownerQQ` / `qqNumber` / `whitelist` → 重启 DSH → 主人私聊「在吗」。
- 端口被占用用 `FISH_HOME_PORT`；只本机用 `FISH_HOME_HOST=127.0.0.1`；`node setup.js --dry-run` 可预演。
- `README-RELEASE.md` 是发布包内安装指南，**留在仓库根，不归档**。

## 不负责

- `setup.js` 的写入位置/备份/字段清洗 → 见 `ops.config-write`。
- 安装后的逐项验收 → 见 `ops.acceptance`。
- 打包/脱敏 → 见 `ops.release`。
- 常见问题 → 见 `ops.troubleshooting`。

## 验收

```powershell
node -v
npm install
node setup.js --dry-run
node cyber_house/api-router.js
```
按 `ops.acceptance` 的「装 / 跑」两组逐项打勾。
