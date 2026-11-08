'use strict'

/**
 * db/index.js —— 赛博小屋的单文件空间数据库
 *
 * 设计目标
 *   1. 家具、网页自建墙 / 房间 / 家具、门洞全部落在同一张 `features` 表里，
 *      运行时读盘只认 `cyber_house.sqlite`，不再到处翻 furniture.json /
 *      features.json；
 *   2. 优先用 better-sqlite3 + SpatiaLite 原生扩展；扩展不可用时自动降级为
 *      「SQLite 存 WKT + Node 内存里用 Turf 精确判定」——两者对上层接口完全一样；
 *   3. 保留 furniture.json / features.json 作为**兼容镜像**：数据库是唯一事实源，
 *      每次写入后顺手导出一份，旧工具（装修、删除、测试）仍能读到最新布局。
 *
 * 表的字段
 *   id / name / type / room / wkt / properties 是任务书要求的统一字段；
 *   额外的 source / geom_type / bbox / updated_at 是为查询和镜像服务的扩展：
 *     - source: furniture（家具文件迁移）/ door（门洞）/ custom（网页绘制）
 *     - geom_type: 解析 WKT 得到的 GeoJSON 类型，便于排查
 *     - min_x..max_y: SQL 包围盒预筛，避免全表两两 Turf 运算
 *
 * 坐标：1000×1000 世界坐标（y 向下），WKT 不带 SRID 前缀。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { ROOMS, ROOMS_BY_NAME, WORLD_SIZE } = require('../world')
const { geometryToWkt, wktToGeometry, geometryBounds } = require('./wkt')
const {
  DEFAULT_MAP_LEVEL,
  normalizeMapLevel,
  isValidMapLevel,
} = require('./map-level')
const { furnitureRowsFromDoc, furnitureDocFromRows } = require('../gis/furniture')
const { validateFeature } = require('../gis/features')

const DB_FILENAME = 'cyber_house.sqlite'
const SCHEMA_FILE = path.join(__dirname, 'schema.sql')
const SCHEMA_VERSION = '1'
// features.type 的合法值集合。
//   furniture / wall / room / door / custom：屋内要素（小屋坐标系）。
//   shp_feature / landmark：外部要素兼容层的兜底类型（校园 SHP 等）
//     —— A* / 拓扑不认它们，只是让动态属性表与渲染有个可读的类型标签。
const FEATURE_TYPES = new Set(['furniture', 'wall', 'room', 'door', 'custom', 'shp_feature', 'landmark'])

/**
 * 建表语句的内置兜底。
 *
 * 正常路径是读同目录的 `schema.sql`（发布包会保留它，方便别人直接看表结构）；
 * 只有这个文件缺失 / 被删掉时才用这里的副本，避免「一个文件没带就把服务卡死」。
 * 两份 DDL 必须保持一致，改一处就改另一处。
 */
const SCHEMA_SQL_FALLBACK = `
  CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT NOT NULL,
    room TEXT,
    wkt TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'custom',
    geom_type TEXT,
    map_level TEXT NOT NULL DEFAULT 'cyber_house',
    min_x REAL NOT NULL,
    min_y REAL NOT NULL,
    max_x REAL NOT NULL,
    max_y REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_features_type ON features(type);
  CREATE INDEX IF NOT EXISTS idx_features_source ON features(source);
  CREATE INDEX IF NOT EXISTS idx_features_room ON features(room);
  CREATE INDEX IF NOT EXISTS idx_features_map_level ON features(map_level);
  CREATE INDEX IF NOT EXISTS idx_features_bbox ON features(min_x, min_y, max_x, max_y);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- 屋里发生的事（任务书 2）：NPC 对话、以后其它事件都往这里追加。
  -- 和 features 分开：事件是只追加的日志，不参与 A* / 拓扑 revision。
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT,
    text TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
  -- 外部 SHP 要素的网页端修改记录（动态属性表）：校园图层来自只读 SHP 文件，
  -- 网页上改过的属性按要素 id 整条存这里，加载时叠在文件属性之上。
  CREATE TABLE IF NOT EXISTS shp_edits (
    id TEXT PRIMARY KEY,
    properties TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
`

/* ---------------------------------------------------------------------------
 * 路径与驱动
 * ------------------------------------------------------------------------- */

function defaultWorkspaceRoot() {
  return path.resolve(__dirname, '..', '..')
}

/**
 * 2026-11-05 布局调整：小鱼资产收在 `<工作区>/DSH-MyFish/`。设置页里仍可能
 * 传外层工作区根，这里向下探测一次，保证数据库、sensors、pipeline 都落在
 * DSH-MyFish 下面，而不是在旧根上重新长出一个空 cyber_house。
 */
function resolveHouseRoot(value) {
  const root = path.resolve(String(value || defaultWorkspaceRoot()))
  const nested = path.join(root, 'DSH-MyFish')
  try {
    if (
      fs.existsSync(path.join(nested, 'cyber_house'))
      || fs.existsSync(path.join(nested, 'dsh-fish-qq'))
    ) {
      return nested
    }
  } catch {
    // 探测失败就退回原根。
  }
  return root
}

function defaultDbFile(workspaceRoot = defaultWorkspaceRoot()) {
  if (process.env.CYBER_HOUSE_DB_FILE) return path.resolve(process.env.CYBER_HOUSE_DB_FILE)
  return path.join(workspaceRoot, 'cyber_house', DB_FILENAME)
}

/**
 * 打开 SQLite：优先 better-sqlite3（同步、快、支持扩展加载），
 * 原生模块不可用时退回 Node 24 内置的 node:sqlite。
 */
function openSqlite(file) {
  let primaryError = null
  try {
    const Database = require('better-sqlite3')
    const db = new Database(file)
    return {
      db,
      driver: 'better-sqlite3',
      sqliteVersion: String((db.prepare('SELECT sqlite_version() AS v').get() || {}).v || ''),
      loadExtension: (extensionPath) => db.loadExtension(extensionPath),
    }
  } catch (error) {
    primaryError = error
  }

  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(file, { allowExtension: true })
    return {
      db,
      driver: 'node:sqlite',
      sqliteVersion: String((db.prepare('SELECT sqlite_version() AS v').get() || {}).v || ''),
      loadExtension: (extensionPath) => db.loadExtension(extensionPath),
    }
  } catch (fallbackError) {
    const message = `没有可用的 SQLite 驱动：better-sqlite3（${primaryError?.message || primaryError}）；node:sqlite（${fallbackError?.message || fallbackError}）`
    throw new Error(message)
  }
}

/* ---------------------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------------------- */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function fileSha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function parseProperties(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function round(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 10) / 10
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 抛一个带 statusCode 的错误，api-router / state-engine 直接转成 HTTP 状态码。 */
function httpLikeError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/* ---------------------------------------------------------------------------
 * 多层级地图底座（任务书 1）的公共工具
 *
 * obstaclesFromRows / doorsFromRows / rasterFeaturesFromRows / rowsBounds
 * 原本散落在 snapshot() 里，按 map_level 过滤后（walkGridInputs /
 * snapshotForLevel）也要同一套逻辑，抽成模块级纯函数。
 * ------------------------------------------------------------------------- */

/** 「整张世界都是可走底」的虚拟房间：非小屋层级没有 6 房间边界。 */
const WORLD_ROOM = { name: 'world', x: 0, y: 0, w: WORLD_SIZE, h: WORLD_SIZE }

/** 家具行 -> A* 矩形障碍（读 properties 的 width/height，缺省时用包围盒）。 */
function obstaclesFromRows(rows) {
  const obstacles = []
  for (const row of rows) {
    if (!row) continue
    const props = row.properties || {}
    const width = Number(props.width) || Math.max(0, row.maxX - row.minX)
    const height = Number(props.height) || Math.max(0, row.maxY - row.minY)
    obstacles.push({
      room: row.room || '',
      type: row.name,
      cx: round((row.minX + row.maxX) / 2),
      cy: round((row.minY + row.maxY) / 2),
      w: round(width),
      h: round(height),
    })
  }
  return obstacles
}

/** 门洞行 -> A* 通行缺口矩形。 */
function doorsFromRows(rows) {
  return rows
    .filter((row) => row && row.type === 'door')
    .map((row) => ({
      name: row.name,
      type: 'door',
      x0: row.minX,
      y0: row.minY,
      x1: row.maxX,
      y1: row.maxY,
    }))
}

/**
 * 交给 featureCells 栅格化的要素：墙 / 自定义家具 / 自建房间。
 * 原始家具已经在 obstacles 里按矩形精确计算，不能再走 15 单位膨胀的栅格化，
 * 否则家具之间的过道会凭空变窄。
 *
 * @param {Array} rows 数据库行
 * @param {FeatureStore} store 用来把行转成 Feature 形状（featureCells 认 properties.type）
 */
function rasterFeaturesFromRows(rows, store) {
  return rows
    .filter((row) => row.source !== 'furniture' && row.type !== 'door')
    .filter((row) => row.type === 'wall' || row.type === 'furniture' || row.type === 'room')
    .map((row) => store.rowToFeature(row))
}

/** 一批行的联合包围盒；没有任何有效几何时返回 null。 */
function rowsBounds(rows) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const row of rows || []) {
    if (!row) continue
    if (!Number.isFinite(row.minX) || !Number.isFinite(row.maxX)) continue
    minX = Math.min(minX, row.minX)
    minY = Math.min(minY, row.minY)
    maxX = Math.max(maxX, row.maxX)
    maxY = Math.max(maxY, row.maxY)
  }
  if (!Number.isFinite(minX)) return null
  return [round(minX), round(minY), round(maxX), round(maxY)]
}

/* ---------------------------------------------------------------------------
 * FeedStore
 * ------------------------------------------------------------------------- */

class FeatureStore {
  constructor(options = {}) {
    this.workspaceRoot = resolveHouseRoot(options.workspaceRoot || defaultWorkspaceRoot())
    this.file = path.resolve(options.dbFile || defaultDbFile(this.workspaceRoot))
    this.furnitureFile = path.resolve(
      options.furnitureFile || path.join(this.workspaceRoot, 'cyber_house', 'furniture.json'),
    )
    this.featuresFile = path.resolve(
      options.featuresFile || path.join(this.workspaceRoot, 'cyber_house', 'features.json'),
    )
    this.writeMirrors = options.mirrors !== false
    this.closed = false
    this._snapshot = null
    // 首次启动（数据库文件还不存在）时打一行日志，方便朋友确认「空库确实自己建好了」。
    this._firstRun = !fs.existsSync(this.file)

    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    this._open()
    this.spatial = this._loadSpatialite()

    if (options.autoMigrate !== false) {
      this.migration = this.migrateFromJson(options.migration || {})
    } else {
      this.migration = { migrated: false, reason: 'disabled' }
    }
  }

  _open() {
    this.handle = openSqlite(this.file)
    this.db = this.handle.db
    this.driver = this.handle.driver
    this.sqliteVersion = this.handle.sqliteVersion
    try {
      this.db.exec('PRAGMA busy_timeout = 5000')
      // 用回滚日志而不是 WAL：数据库保持单个 .sqlite 文件，DB Browser /
      // 备份 / 拷贝时不会漏掉 -wal 里的最新数据。写操作很少，性能足够。
      this.db.exec('PRAGMA journal_mode = DELETE')
      this.db.exec('PRAGMA synchronous = NORMAL')
    } catch (error) {
      // 只读介质 / 特殊文件系统上 pragma 可能失败，不影响主流程。
      console.warn(`[cyber-house/db] pragma 设置失败：${error?.message || error}`)
    }
    this._ensureSchema()
  }

  // @doc house.db-schema
  _ensureSchema() {
    // 多层级地图底座（任务书 1）：旧库的 features 表还没有 map_level 列。
    // SQLite 的 ALTER TABLE ADD COLUMN 不能带 IF NOT EXISTS，这里先查
    // sqlite_master / table_info 再决定。必须在执行 schema.sql 之前补列：
    // schema 里的 idx_features_map_level 索引依赖这一列存在。
    // 补列时给 DEFAULT 'cyber_house'，既有行读出来自动落在赛博小屋这一层，
    // 不走任何数据迁移脚本。
    try {
      const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'features'").get()
      if (table) {
        const columns = this.db.prepare('PRAGMA table_info(features)').all()
        if (Array.isArray(columns) && !columns.some((column) => column && column.name === 'map_level')) {
          this.db.exec("ALTER TABLE features ADD COLUMN map_level TEXT NOT NULL DEFAULT 'cyber_house'")
          console.log('[cyber-house/db] features 表已补上 map_level 列（默认 cyber_house，旧要素全部归属赛博小屋）')
        }
      }
    } catch (error) {
      console.warn(`[cyber-house/db] map_level 列迁移失败：${error?.message || error}`)
    }

    const fromFile = fs.existsSync(SCHEMA_FILE)
    this.db.exec(this._schemaSql())
    if (this.getMeta('schema_version') === null) this.setMeta('schema_version', SCHEMA_VERSION)
    if (this.getMeta('revision') === null) this.setMeta('revision', '0')
    if (this._firstRun) {
      console.log(
        `[cyber-house/db] 首次启动：数据库不存在，已按 ${fromFile ? 'db/schema.sql' : '内置 schema'} 建表 -> ${path.basename(this.file)}`,
      )
    }
  }

  /** 读 schema.sql；缺失或为空时退回内置 DDL（见文件顶部 SCHEMA_SQL_FALLBACK）。 */
  _schemaSql() {
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8')
      if (sql.trim()) return sql
    } catch {
      // 发布包里理应一直带着 schema.sql，这里只是兜底。
    }
    return SCHEMA_SQL_FALLBACK
  }

  /**
   * 尝试加载 SpatiaLite。候选顺序：
   *   SPATIALITE_PATH 环境变量 -> db/ 目录 -> cyber_house/ -> 工作区根 -> PATH。
   * 加载失败不是错误：走 WKT + Turf 降级路径。
   */
  _loadSpatialite() {
    const disabled = process.env.CYBER_HOUSE_DISABLE_SPATIALITE === '1'
    if (disabled) return { enabled: false, reason: 'CYBER_HOUSE_DISABLE_SPATIALITE=1' }

    const suffix = process.platform === 'win32' ? '.dll' : '.so'
    const fileName = `mod_spatialite${suffix}`
    const candidates = [
      process.env.SPATIALITE_PATH,
      path.join(__dirname, fileName),
      path.join(__dirname, '..', fileName),
      path.join(this.workspaceRoot, fileName),
      fileName,
    ].filter(Boolean)

    let lastError = null
    for (const candidate of candidates) {
      const isBare = candidate === fileName
      if (!isBare && !fs.existsSync(candidate)) continue
      try {
        this.handle.loadExtension(candidate)
        const row = this.db.prepare('SELECT spatialite_version() AS version').get()
        const version = row && row.version ? String(row.version) : ''
        if (!version) throw new Error('扩展加载后 spatialite_version() 无返回')
        console.log(`[cyber-house/db] SpatiaLite ${version} 已启用（${candidate}）`)
        return { enabled: true, version, path: candidate, reason: '' }
      } catch (error) {
        lastError = error
      }
    }

    const reason = lastError
      ? `mod_spatialite 加载失败：${String(lastError.message || lastError).slice(0, 160)}`
      : '未找到 mod_spatialite 扩展（WKT + Turf 降级）'
    return { enabled: false, reason }
  }

  /* -------------------------------------------------------------------------
   * meta / revision
   * ----------------------------------------------------------------------- */

  getMeta(key) {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))
      return row ? String(row.value) : null
    } catch {
      return null
    }
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value))
  }

  revision() {
    const value = Number(this.getMeta('revision') || '0')
    return Number.isFinite(value) ? value : 0
  }

  _bumpRevision() {
    this.setMeta('revision', String(this.revision() + 1))
    this._invalidateSnapshot()
  }

  _invalidateSnapshot() {
    this._snapshot = null
  }

  /* -------------------------------------------------------------------------
   * 读
   * ----------------------------------------------------------------------- */

  _mapRow(row) {
    if (!row) return null
    let geometry = null
    try {
      geometry = wktToGeometry(row.wkt)
    } catch {
      geometry = null
    }
    return {
      id: String(row.id),
      name: String(row.name || ''),
      type: String(row.type || 'custom'),
      room: row.room === null || row.room === undefined ? null : String(row.room),
      wkt: String(row.wkt || ''),
      properties: parseProperties(row.properties),
      source: String(row.source || 'custom'),
      // 多图底座（任务书 1）：行级别的层级归属，缺列 / 空值都归赛博小屋。
      mapLevel: normalizeMapLevel(row.map_level),
      // 动态属性表的来源标识：外部 SHP = 'shp'，屋内家具 / 门洞 / 自建要素
      // 分别是 'furniture' / 'door' / 'custom'。读出时注入 properties._source。
      _source: String(row.source || 'custom'),
      geomType: String(row.geom_type || (geometry ? geometry.type : '')),
      minX: Number(row.min_x),
      minY: Number(row.min_y),
      maxX: Number(row.max_x),
      maxY: Number(row.max_y),
      updatedAt: String(row.updated_at || ''),
      geometry,
    }
  }

  listRows(filter = {}) {
    const clauses = []
    const params = []
    if (filter.type) {
      clauses.push('type = ?')
      params.push(String(filter.type))
    }
    if (Array.isArray(filter.types) && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types.map(String))
    }
    if (filter.source) {
      clauses.push('source = ?')
      params.push(String(filter.source))
    }
    if (filter.room) {
      clauses.push('room = ?')
      params.push(String(filter.room))
    }
    // 层级过滤（任务书 1）：按 map_level 隔离查询，SQL 层就直接挡住跨图数据。
    // filter.mapLevel 为 null/'' 时不加条件（全量），交给调用方自己决定口径。
    if (filter.mapLevel) {
      clauses.push('map_level = ?')
      params.push(normalizeMapLevel(filter.mapLevel))
    }
    if (Array.isArray(filter.excludeTypes) && filter.excludeTypes.length > 0) {
      clauses.push(`type NOT IN (${filter.excludeTypes.map(() => '?').join(', ')})`)
      params.push(...filter.excludeTypes.map(String))
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM features ${where} ORDER BY rowid ASC`).all(...params)
    return rows.map((row) => this._mapRow(row))
  }

  getRow(id) {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(String(id))
    return this._mapRow(row)
  }

  countRows() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM features').get()
    return Number((row && row.c) || 0)
  }

  rowToFeature(row) {
    if (!row) return null
    const properties = Object.assign({}, row.properties || {}, {
      type: row.type,
      name: row.name,
    })
    if (row.room) properties.room = row.room
    // 多图底座（任务书 1）：properties 里带一份 map_level，前端 / QGIS 导出
    // 都能直接读到层级归属，存盘时 _normalizeRow 会剥掉它改走专门列。
    properties.map_level = row.mapLevel || DEFAULT_MAP_LEVEL
    // 动态属性表：把来源标识带进 properties，前端面板据此区分
    // 自建要素 / 家具 / 外部 SHP，PATCH 保存时也按同一套前缀路由。
    properties._source = row.source || 'custom'
    return {
      type: 'Feature',
      id: row.id,
      properties,
      geometry: row.geometry,
    }
  }

  _collectionFromRows(rows, name = '赛博小屋·自定义要素') {
    return {
      type: 'FeatureCollection',
      name,
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
      updatedAt: this.getMeta('custom_updated_at') || new Date().toISOString(),
      // 每个要素都带 _source 标识（GET /features / /state 的统一形状）；
      // 重新导入时 _normalizeRow 会剥掉以 _ 开头的派生键。
      features: rows.map((row) => this.rowToFeature(row)),
    }
  }

  snapshot() {
    const revision = this.revision()
    if (this._snapshot && this._snapshot.revision === revision) return this._snapshot

    const rows = this.listRows()
    const furnitureRows = rows.filter((row) => row.source === 'furniture')
    const doorRows = rows.filter((row) => row.type === 'door')
    const customRows = rows.filter((row) => row.source === 'custom')
    // 网页直传的 SHP（source='uploaded_shp'）：只展示 / 可编辑属性，不参与 A* 寻路
    // （它们的 type 固定是 shp_feature，不在障碍类型里）。
    const uploadedRows = rows.filter((row) => row.source === 'uploaded_shp')

    const obstacles = obstaclesFromRows(furnitureRows)
    const doors = doorsFromRows(doorRows)
    const rasterFeatures = rasterFeaturesFromRows(rows, this)

    this._snapshot = {
      revision,
      rows,
      furnitureRows,
      doorRows,
      customRows,
      uploadedRows,
      customFeatures: this._collectionFromRows(customRows),
      uploadedFeatures: this._collectionFromRows(uploadedRows, '赛博小屋·上传 SHP'),
      furnitureDoc: furnitureDocFromRows(rows, ROOMS_BY_NAME),
      obstacles,
      doors,
      rasterFeatures,
    }
    return this._snapshot
  }

  furnitureDoc() {
    return this.snapshot().furnitureDoc
  }

  customFeatures() {
    return this.snapshot().customFeatures
  }

  walkGridInputs(mapLevel) {
    const snapshot = this.snapshot()
    // 任务书 1「寻路栅格隔离」：A* 只看当前 map_level 下的要素，
    // 绝不把别的图里的墙 / 家具混进来。快照按 revision 缓存，这里过滤很便宜。
    const level = normalizeMapLevel(mapLevel)
    if (level === DEFAULT_MAP_LEVEL) {
      return {
        revision: snapshot.revision,
        mapLevel: level,
        rooms: ROOMS,
        obstacles: snapshot.obstacles,
        doors: snapshot.doors,
        features: snapshot.rasterFeatures,
      }
    }
    // 非小屋层级没有 6 房间的边界：整张 0–1000 世界都是可通行底，
    // 只有这一层的墙 / 家具要素（featureCells + obstacles）来挡路。
    const levelRows = snapshot.rows.filter((row) => row.mapLevel === level)
    return {
      revision: snapshot.revision,
      mapLevel: level,
      rooms: [WORLD_ROOM],
      obstacles: obstaclesFromRows(levelRows.filter((row) => row.source === 'furniture')),
      doors: doorsFromRows(levelRows.filter((row) => row.type === 'door')),
      features: rasterFeaturesFromRows(levelRows, this),
    }
  }

  /**
   * 数据库里出现过的全部地图层级（任务书 1）：前端下拉框的数据源。
   * 默认层永远在第一位，其余按字母序；只认规范化的层级名。
   */
  listMapLevels() {
    let levels = [DEFAULT_MAP_LEVEL]
    try {
      const rows = this.db.prepare('SELECT DISTINCT map_level AS level FROM features').all()
      const found = rows
        .map((row) => normalizeMapLevel(row && row.level))
        .filter((level) => level !== DEFAULT_MAP_LEVEL)
        .sort()
      levels = [DEFAULT_MAP_LEVEL].concat(found)
    } catch (error) {
      console.warn(`[cyber-house/db] 读取 map_level 列表失败：${error?.message || error}`)
    }
    return levels
  }

  /**
   * 某一层级要素的包围盒（任务书 1「视野自适应」）：切换层级后前端
   * map.fitBounds() 到这里。小屋层固定是整张 1000×1000 世界（房间边界
   * 画在前端，不进数据库）；其它层级没有要素时也退回整个世界。
   */
  levelBounds(mapLevel) {
    const level = normalizeMapLevel(mapLevel)
    if (level === DEFAULT_MAP_LEVEL) return [0, 0, WORLD_SIZE, WORLD_SIZE]
    const rows = this.snapshot().rows.filter((row) => row.mapLevel === level)
    return rowsBounds(rows) || [0, 0, WORLD_SIZE, WORLD_SIZE]
  }

  /**
   * 某一层级的快照（任务书 1「按地图层级隔离渲染」）：
   * 复用 revision 缓存的全库快照，按 map_level 过滤出这一层的行，
   * 再现场拼出渲染 / 属性表 / 拓扑检查需要的几份视图。
   */
  snapshotForLevel(mapLevel) {
    const snapshot = this.snapshot()
    const level = normalizeMapLevel(mapLevel)
    const rows = snapshot.rows.filter((row) => row.mapLevel === level)
    const furnitureRows = rows.filter((row) => row.source === 'furniture')
    const doorRows = rows.filter((row) => row.type === 'door')
    const customRows = rows.filter((row) => row.source === 'custom')
    const uploadedRows = rows.filter((row) => row.source === 'uploaded_shp')
    return {
      revision: snapshot.revision,
      mapLevel: level,
      rows,
      furnitureRows,
      doorRows,
      customRows,
      uploadedRows,
      customFeatures: this._collectionFromRows(customRows),
      uploadedFeatures: this._collectionFromRows(uploadedRows, '赛博小屋·上传 SHP'),
      furnitureDoc: furnitureDocFromRows(rows, ROOMS_BY_NAME),
      bounds: this.levelBounds(level),
      obstacles: obstaclesFromRows(furnitureRows),
      doors: doorsFromRows(doorRows),
      rasterFeatures: rasterFeaturesFromRows(rows, this),
    }
  }

  /**
   * SQL 预筛重叠候选对。
   *
   * SpatiaLite 启用时直接用 ST_Intersects(ST_GeomFromText(...))；
   * 降级时用索引化的 bbox 自连接（仍然是 SQL，只把精确判定留给 Turf）。
   * 精确的「是否真有面积重叠」由 gis/topology.js 用 Turf 再判一次。
   *
   * @returns {Array<{a:object, b:object}>}
   */
  findOverlapPairs() {
    const rows = this.listRows()
    const byId = new Map(rows.map((row) => [row.id, row]))
    // 用 <= 而不是 <：两个点落在同一坐标也是冲突；面贴边的情况交给 Turf
    // 面积判定排除，不会被误报。
    const bboxWhere = `
      a.type <> 'door' AND b.type <> 'door'
      AND a.min_x <= b.max_x AND b.min_x <= a.max_x
      AND a.min_y <= b.max_y AND b.min_y <= a.max_y
    `

    let pairs = null
    if (this.spatial.enabled) {
      try {
        const sql = `
          SELECT a.id AS a_id, b.id AS b_id
          FROM features a
          JOIN features b ON a.id < b.id
          WHERE ${bboxWhere}
            AND ST_Intersects(ST_GeomFromText(a.wkt, 0), ST_GeomFromText(b.wkt, 0))
        `
        pairs = this.db.prepare(sql).all()
      } catch (error) {
        // 扩展在但函数异常：本次退回 WKT 路径，并把原因记下来。
        this.spatial = {
          enabled: false,
          reason: `ST_Intersects 执行失败：${String(error?.message || error).slice(0, 160)}`,
        }
      }
    }

    if (!pairs) {
      const sql = `
        SELECT a.id AS a_id, b.id AS b_id
        FROM features a
        JOIN features b ON a.id < b.id
        WHERE ${bboxWhere}
      `
      pairs = this.db.prepare(sql).all()
    }

    return pairs
      .map((pair) => ({ a: byId.get(pair.a_id), b: byId.get(pair.b_id) }))
      .filter((pair) => pair.a && pair.b)
  }

  searchFeatures(query) {
    const q = String(query || '').trim()
    if (!q) return []
    const rows = this.listRows({ excludeTypes: ['door'] })
    const candidates = []
    for (const row of rows) {
      const name = String(row.name || row.id)
      if (name === q || name.includes(q) || q.includes(name)) {
        candidates.push({
          id: row.id,
          name,
          room: row.room || '',
          source: row.source === 'custom' ? 'features' : 'furniture',
          type: row.type,
        })
      }
    }
    const exact = candidates.filter((candidate) => candidate.name === q)
    return exact.length > 0 ? exact : candidates
  }

  /* -------------------------------------------------------------------------
   * 屋内事件日志（只追加）
   * ----------------------------------------------------------------------- */

  /**
   * 追加一条屋里发生的事。
   *
   * @param {{type:string, actor?:string, text:string, data?:object, at?:string|number}} input
   * @returns {{id:number, at:string, type:string, actor:string, text:string, data:object|null}}
   */
  appendEvent(input) {
    const now = input && input.at !== undefined
      ? (typeof input.at === 'number' ? new Date(input.at) : new Date(String(input.at)))
      : new Date()
    const at = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString()
    const type = String(input && input.type || 'event').slice(0, 60)
    const actor = input && input.actor === undefined ? null : String(input.actor || '').slice(0, 60)
    const text = String(input && input.text || '').slice(0, 4000)
    const data = input && input.data && typeof input.data === 'object' ? input.data : null
    const result = this.db
      .prepare('INSERT INTO events (at, type, actor, text, data) VALUES (?, ?, ?, ?, ?)')
      .run(at, type, actor, text, data ? JSON.stringify(data) : null)
    return {
      id: Number(result.lastInsertRowid) || 0,
      at,
      type,
      actor: actor || '',
      text,
      data,
    }
  }

  /**
   * 最近事件（按时间正序返回，方便直接念）。
   *
   * @param {{limit?:number, type?:string, since?:string}} [options]
   */
  listEvents(options = {}) {
    const limit = Math.max(1, Math.min(200, Math.round(Number(options.limit) || 20)))
    const clauses = []
    const params = []
    if (options.type) {
      clauses.push('type = ?')
      params.push(String(options.type))
    }
    if (options.since) {
      clauses.push('at >= ?')
      params.push(String(options.since))
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ${limit}`)
      .all(...params)
      .reverse()
    return rows.map((row) => {
      let data = null
      if (row.data) {
        try {
          data = JSON.parse(String(row.data))
        } catch {
          data = null
        }
      }
      return {
        id: Number(row.id),
        at: String(row.at || ''),
        type: String(row.type || ''),
        actor: String(row.actor || ''),
        text: String(row.text || ''),
        data,
      }
    })
  }

  /* -------------------------------------------------------------------------
   * 写
   * ----------------------------------------------------------------------- */

  _normalizeRow(input) {
    const source = String(input.source || 'custom')
    let type = String(input.type || (input.properties && input.properties.type) || 'custom').toLowerCase()
    if (!FEATURE_TYPES.has(type)) type = 'custom'
    const id = String(input.id || (input.properties && input.properties.id) || makeId('feat')).slice(0, 60)
    const name = String(
      input.name || (input.properties && input.properties.name) || (type === 'door' ? '门' : id),
    ).slice(0, 80)
    const geometry = input.geometry || wktToGeometry(input.wkt)
    const wkt = input.wkt || geometryToWkt(geometry)
    const bounds = geometryBounds(geometry)
    if (!bounds) throw new Error(`要素「${name}」没有有效几何`)

    const rawProperties = input.properties && typeof input.properties === 'object' ? input.properties : {}
    const properties = Object.assign({}, rawProperties)
    // 统一字段已经单独入库，properties 里不重复存，镜像时再合并。
    delete properties.id
    delete properties.name
    delete properties.type
    delete properties.room
    // map_level 也由专门列承载：properties 里塞进来的层级值只在入库时读一次，
    // 之后读出一律以列为准（避免属性表手改 map_level 与列不同步）。
    delete properties.map_level
    // _ 前缀留给系统标记（_source 等）：它是数据库读出时注入的派生值，
    // 不能让外部输入往里写，否则来源标识会被伪造。
    for (const key of Object.keys(properties)) {
      if (key.startsWith('_')) delete properties[key]
    }

    return {
      id,
      name,
      type,
      room: input.room === null || input.room === undefined || input.room === '' ? null : String(input.room),
      wkt,
      properties,
      source: type === 'door' ? 'door' : source,
      mapLevel: normalizeMapLevel(input.mapLevel || rawProperties.map_level),
      geomType: String(geometry.type || ''),
      bounds,
      updatedAt: new Date().toISOString(),
    }
  }

  _insertRow(input) {
    const row = this._normalizeRow(input)
    this.db
      .prepare(`
        INSERT INTO features
          (id, name, type, room, wkt, properties, source, geom_type, map_level, min_x, min_y, max_x, max_y, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          room = excluded.room,
          wkt = excluded.wkt,
          properties = excluded.properties,
          source = excluded.source,
          geom_type = excluded.geom_type,
          map_level = excluded.map_level,
          min_x = excluded.min_x,
          min_y = excluded.min_y,
          max_x = excluded.max_x,
          max_y = excluded.max_y,
          updated_at = excluded.updated_at
      `)
      .run(
        row.id,
        row.name,
        row.type,
        row.room,
        row.wkt,
        JSON.stringify(row.properties),
        row.source,
        row.geomType,
        row.mapLevel,
        row.bounds[0],
        row.bounds[1],
        row.bounds[2],
        row.bounds[3],
        row.updatedAt,
      )
    return row
  }

  _transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 回滚失败时保留原始错误。
      }
      throw error
    }
  }

  upsertFeature(feature, options = {}) {
    const source = options.source || 'custom'
    const row = this._transaction(() => {
      const inserted = this._insertRow({
        ...feature,
        source,
        type: (feature.properties && feature.properties.type) || feature.type,
        name: (feature.properties && feature.properties.name) || feature.name,
        room: (feature.properties && feature.properties.room) || feature.room || null,
      })
      this._bumpRevision()
      return inserted
    })
    this._invalidateSnapshot()
    this._writeMirrorForSource(source)
    return this.getRow(row.id)
  }

  /**
   * 批量写入：先全部转行，再在一个事务里插入；任意一条失败整批回滚。
   * @param {Array<object>} features 已校验的 GeoJSON Feature
   * @param {{source?:string}} [options]
   */
  upsertFeatures(features, options = {}) {
    const source = options.source || 'custom'
    const list = Array.isArray(features) ? features : []
    if (list.length === 0) return []
    this._transaction(() => {
      for (const feature of list) {
        this._insertRow({
          ...feature,
          source,
          type: (feature.properties && feature.properties.type) || feature.type,
          name: (feature.properties && feature.properties.name) || feature.name,
          room: (feature.properties && feature.properties.room) || feature.room || null,
        })
      }
      this._bumpRevision()
    })
    this._invalidateSnapshot()
    this._writeMirrorForSource(source)
    return list.map((feature) => this.getRow(String(feature.id)))
  }

  /**
   * 网页直传 SHP 入库：整批按 id upsert（同一份 zip 重传会覆盖自己的旧行，
   * 不会产生重复）。source 固定 'uploaded_shp'，不参与 A* 障碍。
   * @param {Array<object>} features 已解析并换算到世界坐标的 Feature
   */
  importShpFeatures(features) {
    const list = Array.isArray(features) ? features : []
    if (list.length === 0) return []
    return this.upsertFeatures(list, { source: 'uploaded_shp' })
  }

  /** 清空网页直传的 SHP 要素，返回删掉的条数。 */
  clearUploadedFeatures() {
    const rows = this.listRows({ source: 'uploaded_shp' })
    if (rows.length === 0) return 0
    this._transaction(() => {
      this.db.prepare("DELETE FROM features WHERE source = 'uploaded_shp'").run()
      this._bumpRevision()
    })
    this._invalidateSnapshot()
    return rows.length
  }

  /** 当前上传了多少条（给前端显示 / 测试断言用）。 */
  countUploadedFeatures() {
    return this.listRows({ source: 'uploaded_shp' }).length
  }

  deleteFeature(id) {
    const existing = this.getRow(id)
    if (!existing) return null
    this.db.prepare('DELETE FROM features WHERE id = ?').run(String(id))
    this._bumpRevision()
    this._invalidateSnapshot()
    const remaining = this.listRows({ source: existing.source }).length
    this._writeMirrorForSource(existing.source)
    return {
      id: existing.id,
      name: existing.name,
      type: existing.type,
      room: existing.room,
      source: existing.source,
      remaining,
    }
  }

  /**
   * 动态属性表的保存入口（PATCH /features/:id/properties）。
   *
   * 只改属性，不动几何：读出原行 -> 合并修改包 -> name/type/room 仍然
   * 落在专门列上，其余键进 properties JSON -> 原样写回。写入后 bump
   * revision，A* 栅格 / /state 轮询下一轮就看到新值。
   *
   * @param {string} id 要素 id
   * @param {{name?: string, type?: string, room?: string|null, extra?: object}} changes
   *   已由上层校验过的修改包：extra 是除统一字段外的所有键
   * @returns {object} 写回后的完整 Feature（rowToFeature）
   */
  updateFeatureProperties(id, changes) {
    const row = this.getRow(id)
    if (!row) throw httpLikeError(404, `没有找到 id 为「${id}」的要素`)
    const patch = changes && typeof changes === 'object' ? changes : {}
    const extra = patch.extra && typeof patch.extra === 'object' ? patch.extra : {}

    // properties JSON 里只留非系统键；统一字段由列承载。
    const properties = {}
    Object.assign(properties, row.properties || {}, extra)
    for (const key of Object.keys(properties)) {
      if (key.startsWith('_')) delete properties[key]
    }
    delete properties.id
    delete properties.name
    delete properties.type
    delete properties.room

    const nextName = typeof patch.name === 'string' ? patch.name : row.name
    const nextType = typeof patch.type === 'string' && patch.type ? patch.type : row.type
    const nextRoom = patch.room === null || patch.room === undefined ? (patch.room === undefined ? row.room : null) : patch.room

    this._transaction(() => {
      this._insertRow({
        ...row,
        name: nextName,
        type: nextType,
        room: nextRoom,
        properties,
        // _insertRow 用 input.geometry 重建 wkt；复用原 geometry，几何保持不变。
        geometry: row.geometry,
        wkt: row.wkt,
      })
      this._bumpRevision()
    })
    this._invalidateSnapshot()
    this._writeMirrorForSource(row.source)
    return this.rowToFeature(this.getRow(row.id))
  }

  /* -------------------------------------------------------------------------
   * 外部 SHP 要素的属性覆盖（shp_edits 表）
   * 校园图层来自只读 SHP 文件，网页上的修改按要素 id 整条存这里，
   * campus 加载时叠在文件属性之上。
   * ----------------------------------------------------------------------- */

  /** 全部覆盖项：{ id: properties }，给 campus 加载时合并用。 */
  getShpEdits() {
    const rows = this.db.prepare('SELECT id, properties FROM shp_edits').all()
    const map = {}
    for (const row of rows || []) {
      map[String(row.id)] = parseProperties(row.properties)
    }
    return map
  }

  /**
   * 写一条覆盖（整条替换该要素的覆盖属性）。
   * @param {string} id 形如 shp-campus_buildings-3
   * @param {object} properties 合并后的完整属性对象
   */
  upsertShpEdit(id, properties) {
    const key = String(id || '').trim()
    if (!key) throw httpLikeError(400, '要素 id 不能为空')
    const json = JSON.stringify(properties && typeof properties === 'object' ? properties : {})
    this.db
      .prepare(
        `INSERT INTO shp_edits (id, properties, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET properties = excluded.properties, updated_at = excluded.updated_at`,
      )
      .run(key, json, new Date().toISOString())
    return this.db.prepare('SELECT id, properties, updated_at FROM shp_edits WHERE id = ?').get(key)
  }

  /**
   * 用一份 furniture.json 形状的文档整体替换家具 + 门洞。
   * 自定义要素（source=custom）不受影响。
   */
  replaceFurniture(doc) {
    const rows = furnitureRowsFromDoc(doc, ROOMS_BY_NAME)
    this._transaction(() => {
      this.db.prepare("DELETE FROM features WHERE source IN ('furniture', 'door')").run()
      for (const row of rows) {
        // 家具 id 与网页要素撞车时让家具侧让路，不能覆盖用户的绘制成果。
        let id = row.id
        const clash = this.getRow(id)
        if (clash && clash.source === 'custom') {
          let suffix = 2
          while (this.getRow(`${id}-${suffix}`)) suffix += 1
          id = `${id}-${suffix}`
        }
        this._insertRow({ ...row, id })
      }
      this._bumpRevision()
    })
    this._invalidateSnapshot()
    this._writeFurnitureMirror()
    return this.furnitureDoc()
  }

  /* -------------------------------------------------------------------------
   * 兼容镜像（数据库仍是事实源）
   * ----------------------------------------------------------------------- */

  _writeMirrorForSource(source) {
    if (!this.writeMirrors) return
    if (source === 'custom') {
      this._writeFeaturesMirror()
    } else if (source === 'furniture' || source === 'door') {
      this._writeFurnitureMirror()
    }
    // uploaded_shp 这类外部来源没有历史镜像文件，数据库就是唯一事实源。
  }

  _writeFurnitureMirror() {
    if (!this.writeMirrors) return
    try {
      const doc = this.furnitureDoc()
      fs.mkdirSync(path.dirname(this.furnitureFile), { recursive: true })
      fs.writeFileSync(this.furnitureFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[cyber-house/db] furniture.json 镜像写入失败：${error?.message || error}`)
    }
  }

  _writeFeaturesMirror() {
    if (!this.writeMirrors) return
    try {
      const features = this.listRows({ source: 'custom' })
      if (features.length === 0) {
        this.setMeta('custom_updated_at', new Date().toISOString())
        try {
          fs.unlinkSync(this.featuresFile)
        } catch {
          // 文件本来就不存在。
        }
        return
      }
      this.setMeta('custom_updated_at', new Date().toISOString())
      // features.json 是旧版契约的兼容镜像：不写 _source 这类派生系统标记。
      const collection = this._collectionFromRows(features)
      for (const feature of collection.features) delete feature.properties._source
      fs.mkdirSync(path.dirname(this.featuresFile), { recursive: true })
      fs.writeFileSync(this.featuresFile, `${JSON.stringify(collection, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[cyber-house/db] features.json 镜像写入失败：${error?.message || error}`)
    }
  }

  /* -------------------------------------------------------------------------
   * 迁移
   * ----------------------------------------------------------------------- */

  /**
   * 把 furniture.json / features.json 导入数据库。
   * 数据库已有数据时默认跳过；force=true 会清空后重建（CLI 用）。
   */
  // @doc house.db-schema
  migrateFromJson(options = {}) {
    const force = options.force === true
    const count = this.countRows()
    if (count > 0 && !force) {
      return { migrated: false, reason: 'database-not-empty', count }
    }

    const furniture = readJsonFile(this.furnitureFile)
    const featuresDoc = readJsonFile(this.featuresFile)
    const furnitureDoc = furniture && typeof furniture === 'object' && furniture.rooms ? furniture : null
    const featureList = featuresDoc && Array.isArray(featuresDoc.features) ? featuresDoc.features : []

    if (!furnitureDoc && featureList.length === 0 && !force) {
      if (count === 0) {
        this.setMeta('schema_version', SCHEMA_VERSION)
        this.setMeta('migrated_at', new Date().toISOString())
        console.warn(
          '[cyber-house/db] 没找到 cyber_house/furniture.json：先建一座空屋。' +
          '把发布包里的 furniture.json 放回去再重启，就会自动导入初始家具。',
        )
      }
      return { migrated: false, reason: 'no-legacy-files', count }
    }

    const backupDir = options.backup === false ? null : this._backupLegacyFiles()
    const warnings = []

    const buildRows = () => {
      const rows = furnitureDoc ? furnitureRowsFromDoc(furnitureDoc, ROOMS_BY_NAME) : []
      for (const input of featureList) {
        try {
          const feature = validateFeature(input)
          const props = feature.properties || {}
          rows.push({
            id: feature.id,
            name: props.name,
            type: props.type,
            room: typeof input?.properties?.room === 'string' ? input.properties.room.slice(0, 40) : null,
            geometry: feature.geometry,
            properties: {
              icon: props.icon || '',
              color: props.color || '',
              ...(props.interact_text ? { interact_text: props.interact_text } : {}),
            },
            source: 'custom',
          })
        } catch (error) {
          warnings.push(`跳过无法迁移的要素：${String(error?.message || error).slice(0, 120)}`)
        }
      }
      return rows
    }

    const rows = buildRows()
    this._transaction(() => {
      if (force) this.db.prepare('DELETE FROM features').run()
      for (const row of rows) this._insertRow(row)
      this.setMeta('schema_version', SCHEMA_VERSION)
      this.setMeta('migrated_at', new Date().toISOString())
      this.setMeta('legacy_furniture_sha256', fileSha256(this.furnitureFile) || '')
      this.setMeta('legacy_features_sha256', fileSha256(this.featuresFile) || '')
      this.setMeta('legacy_furniture_file', this.furnitureFile)
      this.setMeta('legacy_features_file', this.featuresFile)
      this._bumpRevision()
    })
    this._invalidateSnapshot()

    console.log(
      `[cyber-house/db] 迁移完成：${rows.filter((row) => row.source === 'furniture').length} 件家具、` +
      `${rows.filter((row) => row.type === 'door').length} 个门洞、` +
      `${rows.filter((row) => row.source === 'custom').length} 个自定义要素 -> ${path.basename(this.file)}`,
    )
    for (const warning of warnings) console.warn(`[cyber-house/db] ${warning}`)

    const result = {
      migrated: true,
      count: this.countRows(),
      furniture: rows.filter((row) => row.source === 'furniture').length,
      doors: rows.filter((row) => row.type === 'door').length,
      custom: rows.filter((row) => row.source === 'custom').length,
      backupDir,
      warnings,
    }
    this.migration = result
    return result
  }

  _backupLegacyFiles() {
    const files = [this.furnitureFile, this.featuresFile].filter((file) => fs.existsSync(file))
    if (files.length === 0) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(this.workspaceRoot, 'cyber_house', 'backups', `legacy-json-${stamp}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const file of files) fs.copyFileSync(file, path.join(dir, path.basename(file)))
      console.log(`[cyber-house/db] 旧 JSON 已备份：${dir}`)
      return dir
    } catch (error) {
      console.warn(`[cyber-house/db] 旧 JSON 备份失败：${error?.message || error}`)
      return null
    }
  }

  /* -------------------------------------------------------------------------
   * 状态 / 关闭
   * ----------------------------------------------------------------------- */

  info() {
    const bySource = this.db.prepare('SELECT source, COUNT(*) AS c FROM features GROUP BY source').all()
    const counts = { furniture: 0, door: 0, custom: 0 }
    for (const row of bySource) counts[row.source] = Number(row.c)
    let shpEditsCount = 0
    try {
      shpEditsCount = Number((this.db.prepare('SELECT COUNT(*) AS c FROM shp_edits').get() || {}).c) || 0
    } catch {
      // 老库可能还没有 shp_edits 表。
      shpEditsCount = 0
    }
    let eventCount = 0
    try {
      eventCount = Number((this.db.prepare('SELECT COUNT(*) AS c FROM events').get() || {}).c) || 0
    } catch {
      eventCount = 0
    }
    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(this.file).size
    } catch {
      // 文件刚被移走也不影响状态输出。
    }
    return {
      file: this.file,
      driver: this.driver,
      sqliteVersion: this.sqliteVersion,
      spatialite: Boolean(this.spatial && this.spatial.enabled),
      spatialiteVersion: (this.spatial && this.spatial.version) || '',
      spatialiteReason: (this.spatial && this.spatial.reason) || '',
      schemaVersion: this.getMeta('schema_version') || SCHEMA_VERSION,
      revision: this.revision(),
      featureCount: this.countRows(),
      eventCount,
      furnitureCount: counts.furniture || 0,
      doorCount: counts.door || 0,
      customCount: counts.custom || 0,
      shpEditsCount,
      sizeBytes,
      migration: this.migration || null,
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // 已关闭。
    }
  }
}

/* ---------------------------------------------------------------------------
 * 连接缓存
 * ------------------------------------------------------------------------- */

const connections = new Map()

function openDatabase(options = {}) {
  const workspaceRoot = resolveHouseRoot(options.workspaceRoot || defaultWorkspaceRoot())
  const dbFile = path.resolve(options.dbFile || defaultDbFile(workspaceRoot))
  const key = dbFile
  if (options.fresh !== true) {
    const existing = connections.get(key)
    if (existing && !existing.closed) return existing
  }
  const store = new FeatureStore({ ...options, workspaceRoot, dbFile })
  if (options.fresh !== true) connections.set(key, store)
  return store
}

function closeDatabase(dbFile) {
  if (dbFile) {
    const store = connections.get(path.resolve(dbFile))
    if (store) {
      store.close()
      connections.delete(path.resolve(dbFile))
    }
    return
  }
  for (const store of connections.values()) store.close()
  connections.clear()
}

// 进程退出时尽量把 WAL 落盘（better-sqlite3 正常 close 即可）。
process.once('exit', () => {
  for (const store of connections.values()) {
    try {
      store.close()
    } catch {
      // 退出阶段忽略。
    }
  }
})

module.exports = {
  DB_FILENAME,
  SCHEMA_VERSION,
  DEFAULT_MAP_LEVEL,
  FeatureStore,
  defaultWorkspaceRoot,
  resolveHouseRoot,
  defaultDbFile,
  openDatabase,
  closeDatabase,
  normalizeMapLevel,
  isValidMapLevel,
  // 查询 / 提示用
  WORLD_SIZE,
  WORLD_ROOM,
  ROOMS,
  ROOMS_BY_NAME,
}
