owner: house.db-schema
anchors: cyber_house/db/schema.sql; cyber_house/db/migrate.js#main; cyber_house/db/index.js#migrateFromJson; cyber_house/db/index.js#_ensureSchema
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.db-schema

本文档是 `house.db-schema` 的唯一事实来源：赛博小屋 SQLite 的表结构、索引、`map_level` 列、schema 版本，以及旧 `furniture.json` / `features.json` 的迁移与 `migrate.js` CLI。`/state` 的 `storage` 字段形状归 `house.api.state`。

## 事实

### 表结构（`cyber_house/db/schema.sql`）

所有语句都是 `IF NOT EXISTS`，重复执行不丢数据。几何用 WKT 文本存（不带 SRID 前缀），坐标是 1000×1000 世界坐标，y 向下；`min_x..max_y` 是 SQL 包围盒预筛列，精确判定仍由 Turf 完成。

**`features`**

| 列 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | 要素 id（家具 `living-sofa`、网页要素 `feat-…`、上传 SHP `upl-…-0`） |
| `name` | TEXT | 显示名 |
| `type` | TEXT NOT NULL | `furniture` / `wall` / `room` / `door` / `custom` / `shp_feature` / `landmark` |
| `room` | TEXT | 所属房间（家具 / 门洞有） |
| `wkt` | TEXT NOT NULL | 几何 WKT（`POLYGON ((...))` 等） |
| `properties` | TEXT NOT NULL DEFAULT `'{}'` | 任意 JSON；动态属性面板的键值来源 |
| `source` | TEXT NOT NULL DEFAULT `'custom'` | `furniture` / `door` / `custom` / `uploaded_shp` |
| `geom_type` | TEXT | 几何类型缓存 |
| `map_level` | TEXT NOT NULL DEFAULT `'cyber_house'` | 多图层级归属；旧库自动补列，旧要素归 `cyber_house` |
| `min_x` / `min_y` / `max_x` / `max_y` | REAL NOT NULL | 包围盒预筛 |
| `updated_at` | TEXT NOT NULL | 更新时间 |

索引：`idx_features_type`、`idx_features_source`、`idx_features_room`、`idx_features_map_level`、`idx_features_bbox(min_x,min_y,max_x,max_y)`。

**`meta`**

| 列 | 说明 |
| --- | --- |
| `key` TEXT PRIMARY KEY | 元数据键 |
| `value` TEXT NOT NULL | 值 |

存放 `schema_version`（当前 `SCHEMA_VERSION = '1'`）、`revision`（每次写要素 +1，快照缓存用）、旧 JSON 的路径与 sha256 等。

**`events`**

| 列 | 说明 |
| --- | --- |
| `id` INTEGER PRIMARY KEY AUTOINCREMENT | 自增 id |
| `at` TEXT NOT NULL | 时间 |
| `type` TEXT NOT NULL | 事件类型 |
| `actor` TEXT | 谁 |
| `text` TEXT NOT NULL | 正文 |
| `data` TEXT | 附加 JSON |

只追加的屋内事件日志（NPC 对白等），**不参与 A\* / 拓扑 revision**。索引 `idx_events_type`、`idx_events_at`。

**`shp_edits`**

| 列 | 说明 |
| --- | --- |
| `id` TEXT PRIMARY KEY | 外部 SHP 要素 id |
| `properties` TEXT NOT NULL DEFAULT `'{}'` | 网页上改过的属性覆盖包 |
| `updated_at` TEXT NOT NULL | 更新时间 |

外部 SHP 图层来自只读文件；网页改过的属性按要素 id 整条存这里，campus 加载时叠在文件属性之上。`features` 表不收外部 lon/lat 几何，避免小屋拓扑 / A* 栅格被真实地理坐标污染。

### 建库与补列：`db/index.js`

- `openDatabase()` 在打开时调 `_ensureSchema()`：
  1. 先检查 `features` 是否已有 `map_level` 列；旧库没有就 `ALTER TABLE features ADD COLUMN map_level TEXT NOT NULL DEFAULT 'cyber_house'`。必须在执行 `schema.sql` 之前补列，因为 `idx_features_map_level` 依赖它。
  2. `db.exec(_schemaSql())`；`schema.sql` 缺失或为空时退回文件顶部的内置 DDL 兜底。
  3. `meta.schema_version` 为空时写入 `SCHEMA_VERSION = '1'`；`meta.revision` 为空时写 `'0'`。
  4. 首次启动（数据库不存在）打印「已按 db/schema.sql 建表」；空库会自动 `migrateFromJson()` 导入 `furniture.json` / `features.json`。
- 运行时读盘只认 `cyber_house.sqlite`；`furniture.json` / `features.json` 只作为**兼容镜像**保留（写入后更新），手工改 JSON 后需要 `--force` 才重新导入。
- 驱动优先 `better-sqlite3`，不可用时退回 Node 内置 `node:sqlite`；SpatiaLite 可选，加载失败降级为 WKT + Turf。

### 迁移：`migrateFromJson(options = {})`

- `features` 已有数据且 `force !== true` → 跳过（`{ migrated:false, reason:'already-migrated', count }`）。
- `force !== true` 且没有旧 JSON / 没有要素 → 返回 `no-legacy-files`，建一座空屋并打印「把发布包里的 furniture.json 放回去再重启」。
- 迁移前 `_backupLegacyFiles()`：把 `furniture.json` / `features.json` 复制到 `cyber_house/backups/legacy-json-<时间戳>/`（`options.backup === false` 时跳过）。
- `force: true` 时先 `DELETE FROM features` 再重建；迁移后写 `meta` 的 `legacy_furniture_sha256` / `legacy_features_sha256` / 文件路径。
- 返回 `{ migrated, count, furniture, doors, custom, backupDir }` 等；写失败不抛到调用方（建库失败会带原因）。

### CLI：`db/migrate.js`

```powershell
node cyber_house/db/migrate.js            # 查看状态（空库自动迁移）
node cyber_house/db/migrate.js --status   # 只打印状态
node cyber_house/db/migrate.js --list     # 打印全部要素行
node cyber_house/db/migrate.js --check    # 跑一次拓扑检查
node cyber_house/db/migrate.js --force    # 清空 features 后从旧 JSON 重建
node cyber_house/db/migrate.js --db <path> # 指定数据库文件
```

- `main()` 用 `openDatabase({ workspaceRoot, dbFile, fresh: true })`；`--force` 调 `store.migrateFromJson({ force: true })` 并打印行数（家具 / 门 / 自定义）。
- 总是打印 `store.info()` 的 JSON；`--list` 每行 `id / type / room / name / wkt`；`--check` 调 `gis/topology.js` 的 `checkTopology(store)`，打印冲突数与每条 `[type] message`。
- 失败打印 `[migrate] 失败：…` 并 `process.exitCode = 1`；`finally` 关闭 store。
- `module.exports = { parseArgs }`，可被测试单独引用。

### 已知偏差

- **`meta` 表不在 API.md 的「三表」列表里**：`cyber_house/API.md` §数据层写「`features` / `events` / `shp_edits`」；`schema.sql` 实际还有第四张内部表 `meta`（`schema_version` / `revision` / 旧 JSON 指纹）。它是实现细节，不在 HTTP 契约里。
- **`schemaVersion` 是 `'1'`**：`db/index.js` 的 `SCHEMA_VERSION = '1'`；`API.md` 的 `storage` 示例没有 `schemaVersion` 字段，但代码 `db.info()` 会返回。字段形状归 `house.api.state`。
- **`--force` 的备份范围**：文件头注释说「先备份 `furniture.json` / `features.json`」；代码 `_backupLegacyFiles()` 只复制这两个 JSON，不备份 `cyber_house.sqlite` 本身。要保留旧库请先手动复制 sqlite。
- **「运行时只认数据库」与兼容镜像**：`db/index.js` 写入后会更新 `furniture.json` / `features.json` 镜像；但读取只认 SQLite。手工改 JSON 不生效，必须 `--force` 重新导入。API.md 已写明，代码一致。
- **`map_level` 旧库补列**：`schema.sql` 只负责新库的 `map_level` 列；旧库由 `_ensureSchema()` 在 `schema.sql` 之前 `ALTER TABLE`。API.md 说「旧库首次启动会自动 ALTER TABLE 补列」，与代码一致。
- **与旧 id `house.migrate` 重叠**：T0 的 INDEX 里还有 `house.migrate`（旧 JSON → SQLite 迁移与 `--status/--check/--force`）；T3 按任务书把 `schema.sql` / `migrate.js` 的事实收进本单元，因此 `house.migrate` 目前与本单元有重叠。T4 统一去重/改名时应二选一；在裁决前以本单元的 anchors 为准。
- **`house.db` 的边界**：INDEX 里的 `house.db` 仍保留为「单文件 SQLite 与驱动降级」；表结构、`map_level`、迁移与 CLI 归本单元。`house.db` 的 L1 尚未建立，T4 再收口。

## 不负责

- `/state` 的 `storage` 字段、`features` 的 HTTP CRUD、GeoJSON 导出 → 见 `house.api.state` / `house.features` / `house.geojson`。
- A* 栅格怎么用 `features` 行 → 见 `house.motion` / `house.furniture`。
- 拓扑检查的算法与冲突类型 → 见 `house.furniture`（`gis/topology.js`）。
- 多层级地图的导入接口（`import-qgis` / `upload-shp`） → 见 `house.import`。
- 数据库文件本身的备份/恢复策略（除 `--force` 的旧 JSON 备份外） → 不在本单元。

## 验收

```powershell
node cyber_house/db/migrate.js --status
node cyber_house/db/migrate.js --check
node cyber_house/db/migrate.js --list | Select-Object -First 10
node cyber_house/.headless/db-inspect.js
```

`--status` 的 JSON 应有 `schemaVersion` / `revision` / `featureCount` / `eventCount` / `furnitureCount` / `doorCount` / `customCount` / `shpEditsCount`；`--check` 输出 `[topology] N 处冲突`。
