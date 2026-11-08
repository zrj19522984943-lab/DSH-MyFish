# DSH-MyFish 纯净版 · 安装指南

> ⚠️ 本文档是发布包内给最终用户的安装指南，保持原路径。
> 项目现状与修改索引见 docs/INDEX.md。
> 本文件涉及的事实单元：ops.install, ops.acceptance, ops.config-write

> 这份文档写给第一次装插件的人。照着做就行，不需要看懂代码。
> 安装包里的 `config.example.json` 全是占位符，**不含**作者的记忆、日记、聊天记录、数据库、API Key 或 QQ 号。

## 0. 你会得到什么

| 内容 | 说明 |
| --- | --- |
| `dsh-fish-qq/` | 大肥鱼 + QQ 桥接插件本体（导入 DSH 用这个文件夹） |
| `cyber_house/` | 赛博小屋后端、网页看板、A* 寻路、空间数据库 |
| `cyber_house/furniture.json` | 初始家具模板（14 件家具 + 7 个门洞） |
| `cyber_house/npc_dialogue.json` | 拟南芥和借手的预设台词 |
| `cyber_house/campus/campus_whu.geojson` | 武大校园预设 |
| `pipeline/` | 环境采集、资讯流水线（可选） |
| `sensors/` | 环境状态输出目录（初始只有说明文件） |
| `config.example.json` | 配置模板（复制成 `config.json` 再填） |
| `setup.js` | 把 `config.json` 写到系统正确位置的脚本 |
| `package.json` | 依赖与启动命令 |

发布包里**没有**：`cyber_house.sqlite`、任何 `*.log`、`interaction-outbox.jsonl`、
`~/.dsh-fish/` 的记忆/日记/事件流、`backups/`、`node_modules/`、真实的 API Key 和 QQ 号。

## 1. 前置要求

1. **Windows 10 / 11**（macOS、Linux 也能跑，下面以 Windows 为例）。
2. **Node.js 22 LTS 或更新**（推荐 24）。打开 PowerShell 输入：
   ```powershell
   node -v
   ```
   显示 `v22.x` 或更高即可。没有就去 <https://nodejs.org/zh-cn> 下 LTS 安装包，装完重开终端。
3. **DSH 桌面端 0.2.x**，并且能正常打开。
4. **自己的 DeepSeek API Key**：在 DSH 自己的设置里填，**不要**写进插件目录。
5. 可选：**一个 QQ 小号** + **NapCat**。只想要小屋、不接 QQ 的话可以跳过第 5 节。

> 解压路径建议全英文、不带空格，例如 `D:\DSH-MyFish-Release`。
> 路径里有中文/空格大多也能跑，但出问题时更难排查。

## 2. 五步装好

### 第 1 步：解压

右键压缩包 → **全部解压**，得到 `DSH-MyFish-Release` 文件夹。
不要在压缩包里直接双击 `node` 文件——必须先把文件解压出来。

### 第 2 步：安装依赖

在解压出来的 `DSH-MyFish-Release` 文件夹里，地址栏输入 `powershell` 回车，
或者打开 PowerShell 后执行：

```powershell
cd <解压目录>
npm install
```

- 国内下载慢可以换镜像：`npm config set registry https://registry.npmmirror.com`
- 成功标志：目录下出现 `node_modules` 文件夹，命令没有红色 `ERR`。
- 只装两个运行依赖：`@turf/turf`（空间计算）和 `better-sqlite3`（可选，原生 SQLite）。
  如果 `better-sqlite3` 编译失败，**不影响启动**：Node 22+ 会改用内置的 `node:sqlite`。

### 第 3 步：填配置

复制 `config.example.json` 为 `config.json`，至少填好 `qq.ownerQQ` / `qq.whitelist` / `qq.onebotUrl`，然后在同一目录执行 `node setup.js`；字段含义、两个写入位置、备份与 `--dry-run` 见 [ops.config-write](docs/domains/ops/config-write.md)。

> ⚠️ `config.json` 里有你的 QQ 号，不要分享；隐私边界见 INDEX 的 ops.privacy。

### 第 4 步：导入插件

1. 打开 **DSH 桌面端**。
2. 进入 **插件中心 → 从本地导入插件**。
3. 选择 `<解压目录>\dsh-fish-qq` 这个**文件夹**（不是里面的某个文件）。
4. 插件列表里出现 `dsh-fish-qq` 即导入成功。
5. **完全退出 DSH 再重新打开**（关窗口不算，托盘图标也要退出），让插件重新加载。

### 第 5 步：启动赛博小屋后端

另开一个 PowerShell（这个窗口别关，关了后端就停了）：

```powershell
cd <解压目录>
node cyber_house/api-router.js
```

第一次启动会看到类似输出：

```text
[cyber-house/db] 首次启动：数据库不存在，已按 db/schema.sql 建表 -> cyber_house.sqlite
[cyber-house/db] 迁移完成：14 件家具、7 个门洞、0 个自定义要素 -> cyber_house.sqlite
[cyber-house] API   http://127.0.0.1:8787/api/fish-home/state
[cyber-house] 看板  http://127.0.0.1:8787/home.html
[cyber-house] GIS   http://127.0.0.1:8787/home_leaflet.html
[cyber-house] 局域网访问: http://192.168.1.100:8787
[cyber-house] 手机看板  http://192.168.1.100:8787/home_leaflet.html
```

浏览器打开：<http://127.0.0.1:8787/home_leaflet.html>

手机要打开看板时，用日志里「手机看板」那一行的局域网地址（手机和电脑要在同一个 WiFi）。
第一次监听局域网时 Windows 防火墙可能弹窗，勾选「专用网络」允许即可。
只想本机使用、不暴露局域网：启动前设 `$env:FISH_HOME_HOST = "127.0.0.1"`。

再开一个标签页做健康检查：<http://127.0.0.1:8787/health>
返回里应该有 `"ok": true` 和 `"featureCount": 21`（14 件家具 + 7 个门洞），
以及 `hardware.phoneBattery` / `hardware.network` 两块物理感知自检信息。

## 3. 第一次运行会发生什么

- `cyber_house/cyber_house.sqlite` 不存在 → 后端自动执行 `cyber_house/db/schema.sql` 建表；
- 建表后自动从 `cyber_house/furniture.json` 导入 14 件家具和 7 个门洞；
- `%USERPROFILE%\.dsh-fish` 是空的 → 她是一张白纸：没有日记、没有记忆、没有聊天记录，
  第一天从「信任」阶段开始。这是正常的，不是缺文件；
- QQ 桥接会在 `%USERPROFILE%\.dsh` 下生成自己的状态文件。

想重来：

- 只重置小屋布局：停掉后端 → 删除 `cyber_house\cyber_house.sqlite` → 再启动。
  会自动重新建库并导入家具；代价是网页上自己画的墙/家具会丢。
- 彻底重置她：再删除 `%USERPROFILE%\.dsh-fish`。**她的全部记忆都在里面，删了不可恢复。**

## 4. 目录说明

```text
DSH-MyFish-Release/
├─ dsh-fish-qq/              插件本体（导入 DSH 指向这里）
│  ├─ fish/                  大肥鱼：人格、事件流、记忆、B 站、桌宠
│  └─ qq/                    QQ 桥接：OneBot/NapCat、认主、主动私聊
├─ cyber_house/              赛博小屋
│  ├─ api-router.js          后端入口（node cyber_house/api-router.js）
│  ├─ db/schema.sql          建表脚本（空库首次启动自动执行）
│  ├─ furniture.json         初始家具模板
│  ├─ npc_dialogue.json      拟南芥 / 借手台词
│  ├─ campus/                武大校园 GeoJSON 与转换代码
│  └─ assets/                小鱼贴图
├─ pipeline/                 环境采集 / 资讯流水线（可选）
├─ sensors/                  环境状态输出目录
├─ config.example.json       配置模板
├─ config.json               你填好的配置（自己生成，不要分享）
├─ setup.js                  把配置写入 ~/.dsh-fish 和 ~/.dsh
└─ package.json              npm 依赖与启动命令
```

## 5. 接 QQ（可选）

1. 安装 **NapCat** 并登录你的 QQ 小号。
2. 在 NapCat 的「网络配置」里添加 **WebSocket 服务器**，端口 `3001`（或自定义）。
3. 回到 DSH → 插件设置 → `dsh-fish-qq` → QQ 桥接，确认：
   - `onebotUrl` = `ws://127.0.0.1:3001`
   - `ownerQQ` = 你的主人 QQ
   - `qqNumber` = 小号 QQ
   - `whitelist` 包含你的主人 QQ
4. 保存后重启 DSH。
5. 用主人 QQ 私聊小号，发一句「在吗」。

没反应时按顺序排查：

- NapCat 是否在线、QQ 小号是否登录；
- `onebotUrl` 的端口和 NapCat 里填的是否一致；
- 白名单是否包含你的 QQ（默认 **fail-closed**：不在名单里谁都不能唤醒）；
- DSH 是否真的重启过（插件改动要重启才生效）。

## 6. 常见问题

安装/运行/QQ/小屋的常见症状与排查顺序，见 [ops.troubleshooting](docs/domains/ops/troubleshooting.md)。

## 7. 隐私与安全

- 发布包由打包脚本自动剔除黑名单，并在打包前扫描真实 Key、QQ 号、本机绝对路径；
- `config.example.json` 全部是 `YOUR_..._HERE` 占位符；
- 你的 `config.json`、`%USERPROFILE%\.dsh-fish`、`%USERPROFILE%\.dsh\qq-bridge-*.json`
  都是本机私密数据，不要提交、不要分享；
- 后端默认只监听 `127.0.0.1`，不会暴露到局域网。

## 8. 验收清单

装、跑、QQ、fish、house、发布六组验收的完整表格，见 [ops.acceptance](docs/domains/ops/acceptance.md)。
