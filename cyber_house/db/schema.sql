-- @doc house.db-schema
-- cyber_house/db/schema.sql
--
-- 赛博小屋空间数据库的建表脚本（SQLite）。
--
-- 这个文件是「纯净版」发布包里唯一保留的建表脚本：cyber_house.sqlite
-- 本身是运行时数据，不进发布包。首次启动时 db/index.js 会执行本文件
-- 建表，然后从 cyber_house/furniture.json 导入初始家具与门洞。
--
-- 约定：
--   * 所有语句都是幂等的（IF NOT EXISTS），重复执行不会丢数据；
--   * 几何用 WKT 文本存（不带 SRID 前缀），坐标为 1000×1000 世界坐标，y 向下；
--   * min_x..max_y 是 SQL 包围盒预筛列，精确判定仍由 Turf 完成；
--   * events 是只追加的屋内事件日志，不参与 A* / 拓扑 revision。

--   * events 是只追加的屋内事件日志，不参与 A* / 拓扑 revision；
--   * map_level 是「多图底座」的层级归属（任务书 1）：同一张 features 表里，
--     赛博小屋 / 村庄 / 森林……各画各的，渲染、A* 栅格、拓扑检查都按层级隔离。
--     旧数据没有这一列时，db/index.js 的迁移会补上，默认值 'cyber_house'。

CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  type        TEXT NOT NULL,
  room        TEXT,
  wkt         TEXT NOT NULL,
  properties  TEXT NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL DEFAULT 'custom',
  geom_type   TEXT,
  map_level   TEXT NOT NULL DEFAULT 'cyber_house',
  min_x       REAL NOT NULL,
  min_y       REAL NOT NULL,
  max_x       REAL NOT NULL,
  max_y       REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_features_type      ON features(type);
CREATE INDEX IF NOT EXISTS idx_features_source    ON features(source);
CREATE INDEX IF NOT EXISTS idx_features_room      ON features(room);
CREATE INDEX IF NOT EXISTS idx_features_map_level ON features(map_level);
CREATE INDEX IF NOT EXISTS idx_features_bbox      ON features(min_x, min_y, max_x, max_y);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 屋里发生的事：NPC 对话、以后其它事件都往这里追加。
-- 和 features 分开：事件是只追加的日志，不参与 A* / 拓扑 revision。
CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    TEXT NOT NULL,
  type  TEXT NOT NULL,
  actor TEXT,
  text  TEXT NOT NULL,
  data  TEXT
);

-- 外部 SHP 要素的网页端修改记录（动态属性表）。
-- 校园图层来自 SHP 文件（只读），网页上改过的属性按要素 id 整条存这里，
-- campus 加载时叠在文件属性之上；features 表不收外部 lon/lat 几何，
-- 免得小屋的拓扑 / A* 栅格被真实地理坐标污染。
CREATE TABLE IF NOT EXISTS shp_edits (
  id          TEXT PRIMARY KEY,
  properties  TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_at   ON events(at);
