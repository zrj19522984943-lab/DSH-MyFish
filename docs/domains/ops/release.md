owner: ops.release
anchors: pack-release.js; packaging/setup.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# ops.release

本文档是 `ops.release` 的唯一事实来源：`pack-release.js` 怎么生成纯净版 zip、剔除什么、脱敏什么、打包前怎么扫残留。安装步骤归 `ops.install`。

## 事实

- 入口：仓库根 `node pack-release.js`；输出 `D:\demo\workspace\DSH-MyFish-Release.zip`（解压后 `DSH-MyFish-Release/`）。
- 依赖：`archiver` 从 `packaging/` 解析（不进发布包）；`packaging/setup.js` 复制为发布包根 `setup.js`。
- 生成物：`README-RELEASE.md`、`config.example.json`、`setup.js`、根 `package.json`、`sensors/README.md`。
- 黑名单剔除：记忆/日记/事件流/日志/`cyber_house.sqlite`/`backups/`/`.headless/`/测试与本机调试脚本/`node_modules/`；`README.md` 不混入（发布包用 `README-RELEASE.md`）。
- 脱敏：真实 API Key / QQ 号 / B 站 Cookie / 本机绝对路径替换成 `YOUR_..._HERE` 等占位符；`config.example.json` 从本机 `~/.dsh-fish/config.json` + `~/.dsh/qq-bridge-settings.json` 脱敏生成。
- 打包前扫描暂存目录，发现残留真实凭据/绝对路径就**中止**。
- `README-RELEASE.md` 按文件名从仓库根读取并写入发布包；**不归档**，否则会破坏打包与最终用户安装指南。
- 发布包不含 `cyber_house.sqlite`、任何 `*.log`、`interaction-outbox.jsonl`、`~/.dsh-fish` 记忆/日记/事件流、`backups/`、`node_modules/`。

## 不负责

- 安装五步/前置要求 → 见 `ops.install`。
- 配置写入/字段清洗 → 见 `ops.config-write`。
- 发布后验收 → 见 `ops.acceptance`。
- 源码版本号 → 见 `merge.version-matrix`。

## 验收

```powershell
node pack-release.js
Test-Path ..\DSH-MyFish-Release.zip
```
检查：zip 生成成功、发布包内 `README-RELEASE.md` 完整、无真实 Key/QQ/绝对路径、无 sqlite/日志/node_modules。
