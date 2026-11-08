owner: ops.db-migrate
anchors: cyber_house/db/migrate.js#main
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# ops.db-migrate

本文档是 `ops.db-migrate` 的唯一事实来源：小屋 SQLite 迁移 CLI 的命令与输出。表结构/补列/迁移实现归 `house.db-schema`。

## 事实

- 命令（仓库根或 `cyber_house` 下执行）：
  - `node cyber_house/db/migrate.js`：查看状态（空库自动迁移）；
  - `--status`：只打印状态；
  - `--list`：打印全部要素行（`id/type/room/name/wkt`）；
  - `--check`：跑拓扑检查，打印冲突数与每条 `[type] message`；
  - `--force`：清空 `features` 后从 `furniture.json` / `features.json` 重建；
  - `--db <path>`：指定数据库文件。
- `main()` 用 `openDatabase({workspaceRoot, dbFile, fresh:true})`；`--force` 调 `store.migrateFromJson({force:true})` 并打印行数（家具/门/自定义）。
- 总是打印 `store.info()` JSON（`schemaVersion/revision/featureCount/...`）；`finally` 关闭 store。
- 失败打印 `[migrate] 失败：…` 并 `process.exitCode=1`；`module.exports={parseArgs}` 可测试。
- 迁移前 `_backupLegacyFiles()` 把两个 JSON 复制到 `cyber_house/backups/legacy-json-<时间戳>/`；`--force` 不备份 sqlite 本身。
- 运行前建议停掉 `api-router.js`，避免写锁；迁移后重启后端。

## 不负责

- 表结构/索引/`map_level` 补列/`migrateFromJson` 细节 → 见 `house.db-schema`。
- `/state` 的 `storage` 字段 → 见 `house.api.state`。
- 备份/恢复整包 → 见 fish 的备份/恢复（`fish.identity` 相关单元）。
- 发布包里的数据库 → 见 `ops.release`（sqlite 不进包）。

## 验收

```powershell
node cyber_house/db/migrate.js --status
node cyber_house/db/migrate.js --check
node cyber_house/db/migrate.js --list
node cyber_house/.headless/db-inspect.js
```
重点断言：状态 JSON、`--list` 表头、`--check` 冲突数、`--force` 重建行数、失败退出码 1。
