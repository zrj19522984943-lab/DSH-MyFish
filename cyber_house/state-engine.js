'use strict'

/**
 * state-engine.js —— 赛博小屋主引擎：只保留业务调度与状态维护。
 *
 * 要素数据在 db/（单文件 SQLite），纯算法在 gis/（pathfinder / topology /
 * geojson / features），遥测与传感器在 telemetry/，世界定义在 world.js。
 * 对外导出的名字与行为保持不变。
 *
 * 移动模型（任务书「60帧丝滑移动引擎」模块 2）：后端不再每 2 秒把坐标往前
 * 推一步。寻路成功时引擎把分段贝塞尔点阵挂成一条 _path（含起点时间与总
 * 时长），position 变成「时间」的纯函数——requestAnimationFrame 的前端和
 * 轮询 /state 的任何消费者用同一套公式算位置，渲染帧率从此与轮询频率解耦。
 */

const fs = require('node:fs')
const path = require('node:path')

const {
  WORLD_SIZE,
  ROOMS,
  ROOMS_BY_NAME,
  ACTIVITY_PROFILES,
  DEFAULT_ACTIVITY,
  DEFAULT_ACTIVITY_WINDOWS,
  ROOM_TO_ACTIVITY,
  clamp,
  roundCoordinate,
} = require('./world')

const {
  GRID_CELLS,
  CELL_SIZE,
  buildWalkGrid,
  planRoute,
  segmentBlocked,
  planSmoothRoute,
} = require('./gis/pathfinder')

const { checkTopology: checkTopologyPure, checkRows: checkRowsPure } = require('./gis/topology')
const { buildHouseGeoJSON } = require('./gis/geojson')
const { validateFeature, featureCells } = require('./gis/features')
const { stepInteractionState } = require('./gis/interactions')
const { enqueueInteraction } = require('./interaction-outbox')

/**
 * 动态属性表（外部要素无缝兼容） PATCH 修改包的规模上限。
 * 属性表里的字段可能很多（一栋楼的 DBF 动辄几十个），32 个够改一轮表单。
 */
const MAX_PATCH_KEYS = 32
const MAX_PATCH_KEY_CHARS = 64
const MAX_PATCH_VALUE_CHARS = 2000
/** 自建要素允许的 type（同 gis/features 的绘制 taxonomy）。 */
const OBSTACLE_TYPE_SET = new Set(['furniture', 'wall', 'room'])

/** 抛一个带 statusCode 的错误，api-router 直接转成 HTTP 状态码。 */
function patchError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** 属性值只接受可平铺的 JSON 标量；类型不合法就 400。 */
function sanitizePatchValue(key, value, opts = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw patchError(400, `字段「${key}」不是合法数字`)
    return value
  }
  if (typeof value === 'boolean') return value
  if (value === null) return null
  if (typeof value === 'string') {
    const text = opts.interactText ? value.replace(/\s+/g, ' ') : value
    return text.slice(0, opts.interactText ? 200 : MAX_PATCH_VALUE_CHARS)
  }
  throw patchError(400, `字段「${key}」的值类型不支持（只接受字符串 / 数字 / 布尔 / null）`)
}
const {
  loadNpcDialogueConfig,
  pickDialogue,
  advanceNpc,
  npcSnapshot,
  createNpcs,
} = require('./gis/npcs')
const {
  CAMPUS_BBOX,
  CAMPUS_CENTER,
  virtualToGeo,
  geoToVirtual,
  virtualToGcj02,
  gcj02ToVirtual,
} = require('./gis/campus')
const {
  loadCampusPois,
  nearestCampusPoi,
  campusStatusFor,
  campusPlaceText,
} = require('./gis/campus-poi')
const { openDatabase, resolveHouseRoot } = require('./db')
const { DEFAULT_MAP_LEVEL, normalizeMapLevel, isValidMapLevel } = require('./db/map-level')

const {
  FishTelemetry,
  readSystemHealth,
  readHomeStateFile,
  resolveHomeState,
  resolveActivity,
  resolveRoom,
  defaultDshRoot,
  defaultFishRoot,
  defaultHomeFile,
  defaultWorkspaceRoot,
  defaultFurnitureFile,
  readFurnitureFile,
  writeFurnitureFile,
  defaultFeaturesFile,
  readFeaturesFile,
  writeFeaturesFile,
  emptyUsage,
  localDayKey,
} = require('./telemetry/dsh-telemetry')

// 60帧引擎：position 是时间的纯函数，步长 / 抖动只服务于「离房间中心多远
// 才值得重新规划」「游荡目标至少走多远」这类目标选择逻辑，不再决定帧间速度。
const DEFAULT_STEP = 60
const DEFAULT_JITTER = 8

/**
 * 物理感知事件（任务书：WiFi 抖动 / 手机插拔）的落盘队列。
 *
 * state-engine 和 DSH 的 fish 插件不在一个进程。经验和 current_space.json 一样：
 * 引擎把事件写成 cyber_house/physical_events/<timestamp>.json，插件在每轮组装
 * system prompt 时同步读走、读后删除（每个事件只交付一次），交叉进程不共享内存。
 *
 * TTL 只用于兜底清理：30 分钟没被读走的事件已经过期，再交给 AI 反而像
 * 「刚才有人走动」的假警报。
 */
const PHYSICAL_EVENT_TTL_MS = 30 * 60 * 1000
const PHYSICAL_EVENT_MAX_FILES = 50

// 小鱼沿平滑路径的巡航速度（世界单位/秒）。前端 requestAnimationFrame 与
// 后端 /state 轮询用同一公式 position = f(now - startedAt) 算位置，
// duration = 路径总长 / FISH_PATH_SPEED，60 帧的丝滑由前端补间保证。
// @doc house.motion
const FISH_PATH_SPEED = 110

// 缓动函数（任务书模块 2）：ease-in-out 二次——起步与停靠都有轻微加速度。
// @doc house.motion
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/** 密集点阵的累积弧长：把「时间 -> 弧长 -> 坐标」的第二步变成二分查找。 */
function pathCumulative(points) {
  const cum = [0]
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
    cum.push(total)
  }
  return { cum, total }
}

/**
 * 沿密集点阵按弧长取坐标（任务书：计算当前应处于路径的哪两个点之间）。
 * @returns {{x:number,y:number,index:number,done:boolean}}
 */
function samplePathAt(points, cum, total, distance) {
  if (total <= 0 || points.length < 2) {
    return { x: points[0].x, y: points[0].y, index: 0, done: true }
  }
  const dist = clamp(distance, 0, total)
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (cum[mid] <= dist) lo = mid
    else hi = mid
  }
  const seg = cum[hi] - cum[lo]
  const f = seg > 0 ? (dist - cum[lo]) / seg : 0
  return {
    x: points[lo].x + (points[hi].x - points[lo].x) * f,
    y: points[lo].y + (points[hi].y - points[lo].y) * f,
    index: lo,
    done: dist >= total - 1e-6,
  }
}

function emptyStats() {
  return Object.fromEntries(ROOMS.map((room) => [room.name, 0]))
}

class FishHomeStateEngine {
  constructor(options = {}) {
    this.homeFile = options.homeFile === undefined ? defaultHomeFile() : options.homeFile
    // 设置页可能仍传外层工作区根；统一向下探测 DSH-MyFish，家具 / 传感器 /
    // 数据库路径才不会指回旧根。
    this.workspaceRoot = resolveHouseRoot(options.workspaceRoot || defaultWorkspaceRoot())
    this.furnitureFile = options.furnitureFile || defaultFurnitureFile(this.workspaceRoot)
    this.featuresFile = options.featuresFile || defaultFeaturesFile(this.workspaceRoot)
    // 空间数据库是唯一运行时数据源：家具、门洞、网页绘制的墙 / 房间 / 家具
    // 全在 cyber_house.sqlite 的 features 表里。首次启动会自动从旧 JSON 迁移。
    this.db = options.db || openDatabase({
      workspaceRoot: this.workspaceRoot,
      dbFile: options.dbFile,
      furnitureFile: this.furnitureFile,
      featuresFile: this.featuresFile,
      autoMigrate: options.autoMigrate,
      mirrors: options.mirrors,
      fresh: options.fresh,
    })
    this.systemHealth = readSystemHealth(this.workspaceRoot)
    // 这两个字段保留给旧代码 / 网页接口读取，内容由数据库现算，不再读盘。
    this.furniture = this.db.furnitureDoc()
    this.features = this.db.customFeatures()
    // 小鱼当前所在的空间：'home'（1000×1000 小屋）或 'campus'（武大真实坐标）。
    // 只是展示/交互上下文，不改变 A* 与飞行逻辑；切换通过 API 或前端完成。
    this.currentEnvironment = options.environment === 'campus' ? 'campus' : 'home'
    // 当前地图层级（任务书 1「多层级地图底座」）：cyber_house / village / forest…
    // 决定 A* 障碍栅格取哪些要素、/state 返回哪一层的数据。前端轮询带
    // ?map_level= 时由 api-router 回写到这里；也可以直接 setMapLevel。
    this.currentMapLevel = normalizeMapLevel(options.mapLevel)
    // 校园 POI 表 + 跨进程“当前空间”快照（给 identity 的 system prompt 读）。
    this.campusPois = loadCampusPois()
    this._spaceContextFile = path.join(this.workspaceRoot, 'cyber_house', 'current_space.json')
    this._spaceContextSignature = ''
    this._homeTeleportUntil = 0
    this.step = Number.isFinite(options.step) ? Math.max(1, options.step) : DEFAULT_STEP
    this.jitter = Number.isFinite(options.jitter) ? Math.max(0, options.jitter) : DEFAULT_JITTER
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.random = typeof options.random === 'function' ? options.random : Math.random

    // —— 两个 NPC（任务书 2）——
    // 初始位置固定（各自房间的空白处），之后随机游走；对话配置来自
    // cyber_house/npc_dialogue.json，测试可以用 options 覆盖间隔。
    this._npcEnabled = options.npcs !== false
    this._npcConfig = loadNpcDialogueConfig(
      options.npcDialogueFile || path.join(__dirname, 'npc_dialogue.json'),
    )
    this._npcMinMs = Number.isFinite(options.npcDialogueMinMs)
      ? Math.max(0, options.npcDialogueMinMs)
      : this._npcConfig.minIntervalMinutes * 60_000
    this._npcMaxMs = Number.isFinite(options.npcDialogueMaxMs)
      ? Math.max(this._npcMinMs, options.npcDialogueMaxMs)
      : Math.max(this._npcMinMs, this._npcConfig.maxIntervalMinutes * 60_000)
    this._npcBubbleMs = Number.isFinite(options.npcBubbleMs)
      ? Math.max(1000, options.npcBubbleMs)
      : this._npcConfig.bubbleMs
    this.npcs = this._npcEnabled ? createNpcs(this.now(), this.random) : []
    this._lastNpcDialogue = null
    this._npcNextDialogueAt = this.now() + this._randomNpcDelay()

    this.x = WORLD_SIZE / 2
    this.y = WORLD_SIZE / 2
    this.room = DEFAULT_ACTIVITY.room
    this.status = DEFAULT_ACTIVITY.status
    this.activity = 'idle'
    this.todayUsage = emptyUsage()
    this.statsExact = emptyStats()
    this.dayKey = localDayKey(this.now())
    this.lastTickAt = null
    this.lastHomeError = null
    this.lastKnockAt = 0
    this.lastKnockMessage = ''
    // 平滑移动引擎：_path 是一条「时间驱动」的路线（任务书模块 2），
    // { points, cum, total, startedAt, duration, target, kind }；
    // _pathDistance 是当前已经走过的弧长，供 currentRoute() 裁剪剩余虚线。
    // 旧的 _route/_routeIndex/_followTarget 微操三件套已废弃。
    this._walkGrid = null
    this._walkGridSignature = null
    this._path = null
    this._pathDistance = 0
    this._userDestination = null
    this._userDestinationRoom = null
    this._userDestinationArrived = false
    // 场景交互物块（任务书 1）：featureId -> { triggered, triggeredAt, bubbleUntil }。
    // 只在内存里；服务重启后重新判断距离，不影响数据库里的要素。
    this._interactionState = new Map()
    this._interactionOutbox = options.interactionOutbox !== false
    this.lastInteractionAt = 0
    this.lastInteractionMessage = ''
    // 自主游荡：空闲时每隔 10 秒左右在房间中心附近散一次步。
    this.lastWanderTime = 0
    this.isWandering = false
    this.telemetry = options.telemetry || new FishTelemetry({
      homeFile: this.homeFile,
      dshRoot: options.dshRoot,
      fishRoot: options.fishRoot,
      sessionsRoot: options.sessionsRoot,
      qqStateFile: options.qqStateFile,
      talkRecentFile: options.talkRecentFile,
      activityWindows: options.activityWindows,
    })
  }

  _resetStats(dayKey) {
    this.statsExact = emptyStats()
    this.dayKey = dayKey
    this.lastTickAt = null
  }

  _applyElapsed(nowMs) {
    if (this.lastTickAt == null) {
      this.lastTickAt = nowMs
      return
    }

    const elapsedSeconds = Math.max(0, (nowMs - this.lastTickAt) / 1000)
    this.lastTickAt = nowMs
    if (elapsedSeconds <= 0) return

    // 统计的是“上一次调用时所在的房间”，然后才切换房间。
    this.statsExact[this.room] = (this.statsExact[this.room] || 0) + elapsedSeconds
  }

  /**
   * 网页敲门成功后调用：她至少会在客厅方向待两分钟。
   * 这是网页端真实发生的互动，不依赖她是否马上调用 QQ 工具。
   */
  registerKnock(message = '') {
    this.lastKnockAt = this.now()
    this.lastKnockMessage = String(message || '').slice(0, 500)
  }

  /**
   * 注入一条「物理感知」事件（任务书：局域网抖动 / 手机电量插拔）。
   *
   * 事件有两个去处：
   *   1. SQLite events 表（type=physical）——留下可回看的记录，
   *      小鱼想复盘时 read_house_events 能看到；
   *   2. cyber_house/physical_events/*.json —— 跨进程队列，fish 插件的
   *      fish:physical system prompt 段读走即删，保证每条只交付一次。
   *
   * 这里不直接拼提示词，也不判断该不该说话：只负责把「发生了什么」送到。
   * 反应由小鱼自己决定（任务书要求）。
   *
   * @param {string} text 例如 `[物理感知：主人的手机插上了电脑，当前电量 85%。]`
   * @param {{kind?:string, [key:string]:any}} [meta] 结构化补充信息（延迟、动作等）
   * @returns {object|null} 写入的事件；正文为空时返回 null
   */
  injectPhysicalEvent(text, meta = {}) {
    const clean = String(text ?? '').trim()
    if (!clean) return null

    const nowMs = this.now()
    const id = `phys-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const safeMeta = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {}
    const event = {
      id,
      kind: String(safeMeta.kind || 'hardware').slice(0, 40),
      text: clean.slice(0, 500),
      at: nowMs,
      atISO: new Date(nowMs).toISOString(),
      meta: safeMeta,
    }

    // 1) 事件日志（记录失败不影响提示词交付）。
    try {
      this.db.appendEvent({
        type: 'physical',
        actor: '硬件',
        text: event.text,
        at: nowMs,
        data: { ...safeMeta, eventId: id },
      })
    } catch (error) {
      console.warn(`[cyber-house] 物理感知写事件表失败：${error?.message || error}`)
    }

    // 2) 跨进程队列：先写临时文件再 rename，插件不会读到半截 JSON。
    const dir = path.join(this.workspaceRoot, 'cyber_house', 'physical_events')
    const file = path.join(dir, `${nowMs}-${id.slice(-6)}.json`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(event, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      console.warn(`[cyber-house] 物理感知入队失败：${error?.message || error}`)
    }

    this._prunePhysicalEvents(dir, nowMs)
    console.log(`[cyber-house] 物理感知已注入：${event.text}`)
    return event
  }

  /**
   * 清理物理感知队列：过期文件与超出上限的旧文件。
   * 只删自己的队列文件，绝不碰目录里的其它东西。
   */
  _prunePhysicalEvents(dir, nowMs = this.now()) {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }

    const files = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = path.join(dir, name)
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile()) continue
        files.push({ full, mtimeMs: stat.mtimeMs })
      } catch {
        // 文件刚好被插件读走：跳过。
      }
    }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const staleBefore = nowMs - PHYSICAL_EVENT_TTL_MS
    const overflow = Math.max(0, files.length - PHYSICAL_EVENT_MAX_FILES)
    files.forEach((file, index) => {
      if (index >= overflow && file.mtimeMs >= staleBefore) return
      try {
        fs.unlinkSync(file.full)
      } catch {
        // 已被读走 / 删除失败都无妨。
      }
    })
  }

  /**
   * 可通行栅格：全部输入（家具矩形 / 门洞 / 自建墙 / 自建房间）都从数据库查，
   * 数据库 revision 变了才重建。网页上新画一堵墙会 bump revision，下一轮
   * getState 就带着它重建；别的进程写入也一样看得到。
   *
   * 任务书 1「寻路栅格隔离」：栅格只由当前 map_level 的要素构成——
   * 切到 village 后，赛博小屋的沙发 / 墙绝不参与寻路，反过来也一样。
   * 签名里带上 mapLevel，层级一换栅格立刻重建。
   */
  _currentWalkGrid() {
    const inputs = this.db.walkGridInputs(this.currentMapLevel)
    const signature = `db:${inputs.revision}:level:${inputs.mapLevel}`
    if (this._walkGrid && signature === this._walkGridSignature) return this._walkGrid
    this._walkGrid = buildWalkGrid(
      inputs.rooms,
      inputs.obstacles,
      inputs.doors,
      featureCells(inputs.features),
    )
    this._walkGridSignature = signature
    return this._walkGrid
  }

  /**
   * 切换当前地图层级（任务书 1）：网页下拉框 / ?map_level= 轮询参数都落到这里。
   *
   * 层级变化会作废 A* 栅格缓存与进行中的平滑路径——旧栅格上算出来的路线
   * 在新地图里可能穿墙，必须按新栅格重算。小鱼的位置保持不动：她只是
   * 站在新地图的同一坐标上，下一轮自然活动 / 用户终点会按新栅格重新规划。
   *
   * @param {string} level 目标层级名（不合法时退回 cyber_house）
   * @returns {{ok:boolean, mapLevel:string, previous:string, changed:boolean}}
   */
  setMapLevel(level) {
    const next = normalizeMapLevel(level)
    const previous = this.currentMapLevel
    if (next === previous) return { ok: true, mapLevel: next, previous, changed: false }
    this.currentMapLevel = next
    // 栅格签名里带 mapLevel，这里清掉缓存下一轮自然重建；进行中的路径一并作废。
    this._walkGrid = null
    this._walkGridSignature = null
    this._path = null
    this._pathDistance = 0
    console.log(`[cyber-house] 地图层级已切换：${previous} -> ${next}（A* 栅格与进行中的路径已作废）`)
    return { ok: true, mapLevel: next, previous, changed: true }
  }

  /** 当前地图层级（规范化的层级名）。 */
  getMapLevel() {
    return this.currentMapLevel
  }

  /**
   * 场景交互物块（任务书 1）：小鱼每轮移动后检查一次距离。
   *
   * - 进入 30 单位内且没触发过 -> 写一条 QQ 出站队列 + 生成气泡；
   * - 离开 50 单位外 -> 重置，允许下次再触发；
   * - 队列由 qq 桥接消费并私聊主人，状态引擎本身不直接碰 QQ 连接。
   *
   * @param {number} nowMs
   * @param {object|null} [spatialSnapshot] 复用 getState 已经取过的数据库快照
   * @returns {{triggered:Array, reset:Array, bubbles:Array}}
   */
  _updateInteractions(nowMs, spatialSnapshot = null) {
    const spatial = spatialSnapshot || this.db.snapshot()
    const result = stepInteractionState(
      spatial.rows,
      this.x,
      this.y,
      this._interactionState,
      nowMs,
    )
    this._interactionState = result.nextState

    for (const hit of result.triggered) {
      const message = `[系统：小鱼碰到了${hit.name}，触发对话：“${hit.text}”]`
      this.lastInteractionAt = nowMs
      this.lastInteractionMessage = message
      if (this._interactionOutbox) {
        try {
          enqueueInteraction({
            workspaceRoot: this.workspaceRoot,
            featureId: hit.id,
            featureName: hit.name,
            text: hit.text,
            now: nowMs,
          })
        } catch (error) {
          // 队列写不进去不能影响小鱼移动 / 网页；桥接下次能读到就够了。
          console.warn(`[cyber-house] 交互消息入队失败：${error?.message || error}`)
        }
      }
      console.log(`[cyber-house] 交互触发：${message}`)
    }

    return result
  }

  /** 两段 NPC 对白之间的随机间隔。 */
  _randomNpcDelay() {
    if (this._npcMaxMs <= this._npcMinMs) return this._npcMinMs
    return this._npcMinMs + Math.floor(this.random() * (this._npcMaxMs - this._npcMinMs + 1))
  }

  /**
   * 推进两个 NPC，并检查是不是该抽下一段对白了。
   * @param {number} nowMs
   * @returns {Array<object>} 前端需要的 NPC 快照
   */
  _updateNpcs(nowMs) {
    if (!this._npcEnabled) return []
    if (this.npcs.length > 0) {
      const passable = this._currentWalkGrid()
      for (const npc of this.npcs) {
        advanceNpc(npc, passable, nowMs, this.random, ROOMS)
      }
    }
    this._maybeNpcDialogue(nowMs)
    return this.npcs.map((npc) => npcSnapshot(npc, nowMs))
  }

  /**
   * 到点就抽一段对白：写 events 日志 + 给说话的 NPC 挂气泡。
   * 5–10 分钟的间隔由 npc_dialogue.json 配，测试可把间隔调到 0。
   */
  _maybeNpcDialogue(nowMs) {
    if (!this._npcEnabled || nowMs < this._npcNextDialogueAt) return null
    const dialogue = pickDialogue(
      this._npcConfig.dialogues,
      this.random,
      this._lastNpcDialogue ? this._lastNpcDialogue.id : '',
    )
    if (!dialogue) {
      this._npcNextDialogueAt = nowMs + this._randomNpcDelay()
      return null
    }

    this._lastNpcDialogue = {
      id: dialogue.id,
      at: nowMs,
      lines: dialogue.lines.map((line) => ({ speaker: line.speaker, text: line.text })),
    }
    this._npcNextDialogueAt = nowMs + this._randomNpcDelay()

    for (const line of dialogue.lines) {
      try {
        this.db.appendEvent({
          type: 'npc_dialogue',
          actor: line.speaker,
          text: line.text,
          at: nowMs,
          data: { dialogueId: dialogue.id },
        })
      } catch (error) {
        console.warn(`[cyber-house] NPC 对话写库失败：${error?.message || error}`)
      }
      const npc = this.npcs.find((item) => item.name === line.speaker)
      if (npc) {
        npc.bubble = {
          text: line.text,
          at: nowMs,
          expiresAt: nowMs + this._npcBubbleMs,
        }
      }
      console.log(`[cyber-house] NPC 对话：${line.speaker}：“${line.text}”`)
    }
    return dialogue
  }

  /**
   * 前端画导航虚线要的那串剩余路径点：从当前脚下位置开始，到终点为止。
   *
   * 平滑路径是密集贝塞尔点阵，这里按已走过的弧长裁剪剩余部分；
   * 没有进行中的路线（直线活动目标 / 站着不动）时返回空数组，
   * 老消费者（GeoJSON 导出、校园模式）自动拿到一条圆滑的 LineString。
   */
  currentRoute() {
    if (!this._path) return []
    const { points } = this._path
    let index = 0
    const cum = this._path.cum
    while (index < cum.length - 1 && cum[index + 1] <= this._pathDistance) index += 1
    const remaining = [{ x: this.x, y: this.y }].concat(points.slice(index + 1))
    return remaining.map((point) => ({
      x: roundCoordinate(point.x),
      y: roundCoordinate(point.y),
    }))
  }

  /**
   * 规划并挂载一条时间驱动的平滑路径：A* 折线 -> 分段三次贝塞尔 -> 安全校验。
   * 不再当场挪坐标——她的位置交给时钟，前端拿到 pathStart 就能自行 60 帧播放。
   *
   * @param {number} toX 目标 x
   * @param {number} toY 目标 y
   * @param {'user'|'wander'|'activity'|'idle'} kind 谁要她走这条路
   * @param {number} nowMs 起点时间（Date.now()）
   * @returns {boolean} true 表示真的挂上了一条路；太近（<2 单位）时直接就位并返回 false
   */
  // @doc house.motion
  _startPathTo(toX, toY, kind, nowMs) {
    // 若身上还挂着上一条没走完的路，先按当前时刻采样一次：
    // 新路径必须从「现在这张位置」出发，不然会倒退几步。
    if (this._path) this._samplePath(nowMs)

    const inputs = this.db.walkGridInputs(this.currentMapLevel)
    const planned = planSmoothRoute(
      this.furniture,
      inputs.rooms,
      ROOMS_BY_NAME,
      this.x,
      this.y,
      Number(toX),
      Number(toY),
      {
        passable: this._currentWalkGrid(),
        obstacles: inputs.obstacles,
        doors: inputs.doors,
      },
    )
    const points = planned.smoothPath.points
    const { cum, total } = pathCumulative(points)
    if (!Number.isFinite(total) || total < 2) {
      // 近在咫尺：直接就位，不建路径（前端也就没有要点阵的动画）
      const end = points[points.length - 1]
      if (end && Number.isFinite(end.x) && Number.isFinite(end.y)) {
        this.x = clamp(end.x, 0, WORLD_SIZE)
        this.y = clamp(end.y, 0, WORLD_SIZE)
      }
      this._path = null
      this._pathDistance = 0
      return false
    }

    this._path = {
      points,
      cum,
      total,
      startedAt: nowMs,
      duration: (total / FISH_PATH_SPEED) * 1000,
      target: { x: Number(toX), y: Number(toY) },
      kind,
    }
    this._pathDistance = 0
    return true
  }

  /**
   * 按当前时刻在 _path 上采样，写回 this.x / this.y（时间驱动移动）。
   * @param {number} nowMs
   * @returns {{done:boolean}|null} null 表示没有进行中的路线
   */
  _samplePath(nowMs) {
    if (!this._path) return null
    const { points, cum, total, startedAt, duration } = this._path
    // 缓动作用在整条路径的时间轴上：起步加速、停靠减速
    const t = duration > 0
      ? clamp((Math.max(nowMs, startedAt) - startedAt) / duration, 0, 1)
      : 1
    const distance = easeInOut(t) * total
    const sample = samplePathAt(points, cum, total, distance)
    this.x = clamp(sample.x, 0, WORLD_SIZE)
    this.y = clamp(sample.y, 0, WORLD_SIZE)
    this._pathDistance = distance
    if (t >= 1) {
      // 走完了：贴着终点，路径生命周期结束
      this._path = null
      this._pathDistance = 0
      return { done: true }
    }
    return { done: false }
  }

  /** 坐标落在哪个房间里；落在房间之间的空隙就返回 null。 */
  _roomAt(x, y) {
    for (const room of ROOMS) {
      if (x >= room.x && x <= room.x + room.w && y >= room.y && y <= room.y + room.h) {
        return room.name
      }
    }
    return null
  }

  /**
   * 网页"规划路线"按钮调用：把小鱼的目的地改成 (x, y)。
   *
   * 关键修复（2026-11-04）：点击的瞬间就按坐标判断目标房间，立刻改写
   * this.room / this.status。
   *
   * 移动模型（2026-11-06，任务书「60帧丝滑移动引擎」）：不再当场挪坐标，
   * 而是规划 A* 折线 + 分段贝塞尔平滑，挂成一条时间驱动的 _path；
   * 前端拿到响应里的 smoothPath / pathStart / pathDuration 即开始 60 帧播放。
   */
  setDestination(x, y) {
    const tx = Number(x)
    const ty = Number(y)
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      return { ok: false, error: '终点坐标不是有效数字' }
    }

    const destination = {
      x: clamp(tx, 0, WORLD_SIZE),
      y: clamp(ty, 0, WORLD_SIZE),
    }
    const room = this._roomAt(destination.x, destination.y)

    this._userDestination = destination
    this._userDestinationRoom = room || this.room
    this._userDestinationArrived = false
    if (room) this.room = room
    this.status = '前往目的地'

    // 用户点终点 = 立刻放弃溜达，改走导航。
    this.isWandering = false
    this.lastWanderTime = this.now()
    this._path = null
    this._pathDistance = 0
    // 立刻规划挂载一条平滑路径（不挪坐标，交给时间轴）；
    // 近在咫尺时直接就位并标记已到达。
    const armed = this._startPathTo(destination.x, destination.y, 'user', this.now())
    if (!armed) {
      this._userDestinationArrived = true
    }

    return {
      ok: true,
      destination: { ...destination },
      route: this.currentRoute(),
      // 前端 60 帧引擎直接消费的三件套（任务书模块 2）
      smoothPath: this._path ? this._path.points : [],
      pathStart: this._path ? this._path.startedAt : null,
      pathDuration: this._path ? this._path.duration : 0,
    }
  }

  /**
   * 网页"清除路线"按钮调用：放弃用户指定的终点和导航线，
   * 小鱼下一次 getState() 就会回到活动房间推断出来的自然目标。
   */
  clearDestination() {
    this._userDestination = null
    this._userDestinationRoom = null
    this._userDestinationArrived = false
    this._path = null
    this._pathDistance = 0
    this.isWandering = false
    this.lastWanderTime = this.now()
    return { ok: true }
  }

  /**
   * 切换展示/交互空间：'home'（虚拟小屋）或 'campus'（武大真实地图）。
   *
   * 任务书「跨空间传送」：网页点去武大 / 回小屋时传 teleport=true，
   * 先把小鱼放到目标空间的中点（校园 BBox 中心 / 客厅中心），再清掉旧路线。
   */
  setEnvironment(environment, options = {}) {
    const next = environment === 'campus' ? 'campus' : 'home'
    const teleport = options.teleport === true
    this.currentEnvironment = next
    this._path = null
    this._pathDistance = 0
    this._userDestination = null
    this._userDestinationRoom = null
    this._userDestinationArrived = false
    this.isWandering = false
    this.lastWanderTime = this.now()

    if (teleport) {
      if (next === 'campus') {
        // 校园 BBox 中心（虚拟 500,500）
        this.x = WORLD_SIZE / 2
        this.y = WORLD_SIZE / 2
        this._homeTeleportUntil = 0
      } else {
        const living = ROOMS_BY_NAME['客厅']
        this.x = living.cx
        this.y = living.cy
        this.room = '客厅'
        this.status = '在家休息'
        this.activity = 'idle'
        // 两分钟内不被 idle 遥测立刻拉回阳台；之后按真实活动走。
        this._homeTeleportUntil = this.now() + 2 * 60 * 1000
      }
    }

    const poi = next === 'campus' ? nearestCampusPoi(this.x, this.y, this.campusPois) : null
    const displayRoom = next === 'campus'
      ? (poi ? poi.name : '武汉大学')
      : (teleport ? '客厅' : this.room)
    const displayStatus = next === 'campus'
      ? campusStatusFor(poi)
      : (teleport ? '在家休息' : this.status)
    this._writeSpaceContext({
      nowMs: this.now(),
      room: displayRoom,
      status: displayStatus,
      poi,
      force: true,
    })

    return {
      ok: true,
      environment: next,
      teleport,
      position: { x: roundCoordinate(this.x), y: roundCoordinate(this.y) },
    }
  }

  getEnvironment() {
    return this.currentEnvironment
  }

  /** 小鱼当前坐标的真实地理表示（WGS84 + 高德用的 GCJ02）。 */
  // @doc house.api.state
  getGeoPosition() {
    const geo = virtualToGeo(this.x, this.y)
    const geoGcj02 = virtualToGcj02(this.x, this.y)
    return {
      environment: this.currentEnvironment,
      virtual: { x: roundCoordinate(this.x), y: roundCoordinate(this.y) },
      geo: { lng: geo.lng, lat: geo.lat, coordinateSystem: 'wgs84' },
      geoGcj02: { lng: geoGcj02.lng, lat: geoGcj02.lat, coordinateSystem: 'gcj02' },
      bbox: { ...CAMPUS_BBOX },
      center: { ...CAMPUS_CENTER },
    }
  }

  /**
   * 把「此刻在哪」写成 cyber_house/current_space.json。
   *
   * 为什么要落文件：state-engine 是独立 Node 进程，fish 的 identity 段在 DSH
   * 宿主进程里；它需要每轮组装 system prompt 时同步读到环境/POI，不能反过来
   * 请求 /state（会推进小鱼、产生副作用）。文件很小，按签名去重。
   */
  _writeSpaceContext({ nowMs, room, status, poi = null, force = false } = {}) {
    const environment = this.currentEnvironment
    const geo = virtualToGeo(this.x, this.y)
    const geoGcj02 = virtualToGcj02(this.x, this.y)
    const payload = {
      environment,
      room: String(room || ''),
      status: String(status || ''),
      poi: poi ? { name: String(poi.name || ''), kind: String(poi.kind || ''), distance: Math.round(Number(poi.distance) || 0) } : null,
      virtual: { x: roundCoordinate(this.x), y: roundCoordinate(this.y) },
      geo: { lng: geo.lng, lat: geo.lat },
      geoGcj02: { lng: geoGcj02.lng, lat: geoGcj02.lat },
      updatedAt: new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()).toISOString(),
    }
    const signature = JSON.stringify([
      payload.environment,
      payload.room,
      payload.status,
      payload.poi && payload.poi.name,
      payload.virtual.x,
      payload.virtual.y,
    ])
    if (!force && signature === this._spaceContextSignature) return payload
    try {
      fs.mkdirSync(path.dirname(this._spaceContextFile), { recursive: true })
      const tmp = `${this._spaceContextFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, this._spaceContextFile)
      this._spaceContextSignature = signature
    } catch (error) {
      console.warn(`[cyber-house] 当前空间快照写入失败：${error?.message || error}`)
    }
    return payload
  }

  /**
   * 校园模式点击地图：把真实经纬度反算成虚拟坐标，再走同一条 A* 导航。
   *
   * @param {number} lng
   * @param {number} lat
   * @param {'wgs84'|'gcj02'} [coordinateSystem]
   */
  setGeoDestination(lng, lat, coordinateSystem = 'wgs84') {
    const numberLng = Number(lng)
    const numberLat = Number(lat)
    if (!Number.isFinite(numberLng) || !Number.isFinite(numberLat)) {
      return { ok: false, error: '经纬度不是有效数字' }
    }
    const virtual = coordinateSystem === 'gcj02'
      ? gcj02ToVirtual(numberLng, numberLat)
      : geoToVirtual(numberLng, numberLat)
    this.currentEnvironment = 'campus'
    const result = this.setDestination(virtual.x, virtual.y)
    if (!result || result.ok !== true) return result
    return {
      ...result,
      environment: 'campus',
      virtual,
      geo: virtualToGeo(virtual.x, virtual.y),
      geoGcj02: virtualToGcj02(virtual.x, virtual.y),
    }
  }

  /**
   * 拓扑检查：全要素重叠 / 越界 + 堵门。供 /state 接口与 fish_check_topology 工具共用。
   *
   * 任务书 1：按地图层级隔离——village 里的墙不用和赛博小屋的沙发和睦相处，
   * 跨图重叠根本不算冲突（它们不在同一张地图上）。
   *
   * @param {string|null} mapLevel 传 null 检查全部层级（fish_check_topology 的旧契约），
   *   传层级名则只检查这一层（/state 的 topologyErrors 走这条）
   */
  checkTopology(mapLevel = null) {
    const level = mapLevel === null || mapLevel === undefined ? null : normalizeMapLevel(mapLevel)
    if (level === null) return checkTopologyPure(this.db)
    const rows = this.db.snapshotForLevel(level).rows
    // 不走 SQL 候选对（那是全库的）：这一层的行自己做一遍 bbox 预筛 + Turf 精判。
    return checkRowsPure(rows, ROOMS_BY_NAME, {})
  }

  /** 自定义要素集合（数据库 source=custom），GET /api/fish-home/features 直接返回。 */
  getCustomFeatures() {
    return this.db.customFeatures()
  }

  /**
   * 网页「绘制要素」接口调用：校验一个 GeoJSON Feature，写进数据库，
   * 立刻作废缓存的 A* 栅格（下一轮 getState 重建）。
   *
   * @param {object} featureGeoJSON 前端 POST 上来的 GeoJSON Feature
   * @returns {object} 写入后的完整 FeatureCollection
   * @throws {Error} 带 statusCode=400 的校验错误，api-router 直接回给前端
   */
  addFeature(featureGeoJSON) {
    const feature = validateFeature(featureGeoJSON)
    const existing = this.db.getRow(feature.id)
    if (existing && existing.source !== 'custom') {
      const error = new Error(`要素 id「${feature.id}」已经被${existing.source === 'furniture' ? '家具' : '门洞'}占用`)
      error.statusCode = 409
      throw error
    }
    this.db.upsertFeature(feature, { source: 'custom' })
    this._invalidateSpatialCaches(`新增${feature.properties.type}「${feature.properties.name}」`)
    console.log(`[cyber-house] 新要素已保存：${feature.properties.type}「${feature.properties.name}」(${feature.geometry.type}) -> ${path.basename(this.db.file)}`)
    return this.getCustomFeatures()
  }

  /**
   * 批量版 addFeature（POST /api/fish-home/features 一次可以收一个 FeatureCollection）。
   * 先全部校验，再在一个数据库事务里写入；任意一个失败整批不落库。
   *
   * @param {Array} list GeoJSON Feature 数组
   * @returns {object} 写入后的完整 FeatureCollection
   */
  addFeatures(list) {
    const features = Array.isArray(list) ? list : [list]
    const validated = features.map((item) => validateFeature(item))
    for (const feature of validated) {
      const existing = this.db.getRow(feature.id)
      if (existing && existing.source !== 'custom') {
        const error = new Error(`要素 id「${feature.id}」已经被${existing.source === 'furniture' ? '家具' : '门洞'}占用`)
        error.statusCode = 409
        throw error
      }
    }
    this.db.upsertFeatures(validated, { source: 'custom' })
    this._invalidateSpatialCaches(`新增 ${validated.length} 个要素`)
    return this.getCustomFeatures()
  }

  /**
   * QGIS 导入写盘（任务书 1「QGIS 数据无缝接入」）。
   *
   * 与 addFeatures 同样的「校验占用 → 事务写入 → 作废空间缓存」流程，
   * 区别是这里的要素由 gis/features.normalizeImportFeatures 预先规范化过：
   * 宽松类型（非 wall/furniture/room 一律 shp_feature 只展示）、
   * 带各自的 map_level、Multi* 已拆成单部分几何。
   *
   * @param {Array} features 规范化后的 Feature 数组（每条带 mapLevel）
   * @returns {Array} 写入后的数据库行
   * @throws {Error} 带 statusCode=409 的 id 占用错误
   */
  importGeoJsonFeatures(features) {
    const list = Array.isArray(features) ? features : []
    if (list.length === 0) return []
    for (const feature of list) {
      const existing = this.db.getRow(feature.id)
      if (existing && existing.source !== 'custom') {
        const error = new Error(`要素 id「${feature.id}」已经被${existing.source === 'furniture' ? '家具' : '门洞'}占用`)
        error.statusCode = 409
        throw error
      }
    }
    const rows = this.db.upsertFeatures(list, { source: 'custom' })
    this._invalidateSpatialCaches(`QGIS 导入 ${list.length} 个要素`)
    console.log(`[cyber-house] QGIS 导入完成：${list.length} 个要素 -> ${path.basename(this.db.file)}`)
    return rows
  }

  /**
   * 网页 / QQ「删除要素」：按 id 在统一要素表里找，找到就删掉，
   * 并立刻作废 A* 寻路栅格缓存。
   *
   * @param {string} featureId 要素 id（自定义要素 feat-xxx / 家具 bedroom-bed / 门洞）
   * @returns {{ok:boolean, source:string, id:string, name:string, target:string}|{ok:false, error:string}}
   */
  removeFeatureById(featureId) {
    const id = String(featureId || '').trim()
    if (!id) return { ok: false, error: '要素 id 不能为空' }

    const row = this.db.getRow(id)
    if (!row) return { ok: false, error: `没有找到 id 为「${id}」的要素（数据库里没有）` }

    const removed = this.db.deleteFeature(id)
    this._invalidateSpatialCaches(`删除要素「${row.name || id}」`)
    return {
      ok: true,
      source: row.source === 'custom' ? 'features' : row.source,
      id,
      name: String(row.name || id),
      target: row.source === 'furniture' ? (row.room || '') : row.type,
      remaining: removed ? removed.remaining : 0,
    }
  }

  /** 按名字找要素（给 QQ 删除工具用，避免它再去读 features.json）。 */
  searchFeatures(query) {
    return this.db.searchFeatures(query)
  }

  /**
   * 动态属性表的保存入口（PATCH /api/fish-home/features/:id/properties）。
   *
   * 只改属性、不动几何。分两条路：
   *   - id 形如 shp-xxx 的外部 SHP 要素：改的是文件属性的「覆盖包」，
   *     存进 shp_edits 表，campus 加载时叠在文件属性之上（文件本身只读）；
   *   - 屋内要素（custom / furniture / door）：合进 features 表的
   *     properties 列，name / type / room 仍然落在专门列上。
   *
   * 值得一提的连带约束：furnitureDocFromRows 用 properties.localX/localY
   * 重建家具镜像，而 A* 栅格用 wkt 几何 —— 这两套读不同地方，所以凡是
   * 会改动「布局簿记字段」的修改在这里就被拦下，免得渲染和寻路对不上。
   *
   * @param {string} featureId 要素 id（feat-xxx / 家具 id / shp-xxx）
   * @param {object} patch 前端送来的 { key: newValue } 修改包
   * @returns {Promise<{source: string, feature: object}>}
   * @throws {Error} 带 statusCode 的校验错误，api-router 直接回给前端
   */
  async updateFeatureProperties(featureId, patch) {
    const id = String(featureId || '').trim()
    if (!id) throw patchError(400, '要素 id 不能为空')

    if (id.startsWith('shp-')) {
      return this._applyShpPropertyPatch(id, patch)
    }

    const parsed = this._parsePropertyPatch(patch, { shp: false })
    const row = this.db.getRow(id)
    if (!row) throw patchError(404, `没有找到 id 为「${id}」的要素（数据库里没有）`)

    this._guardPatchForSource(row, parsed)

    const oldType = row.type
    const feature = this.db.updateFeatureProperties(id, parsed)

    // 快照按 revision 缓存（db.updateFeatureProperties 已经 bump），
    // 下一轮 getState / _currentWalkGrid / 交互视图都会自动看到新值。
    // 这里只同步引擎缓存的两个文档字段，以及「障碍栅格成员变化」时
    // 停掉进行中的平滑路径：小鱼不能按旧栅格走完剩下的一段。
    this.furniture = this.db.furnitureDoc()
    this.features = this.db.customFeatures()
    const typeChanged = parsed.type && row.source === 'custom' && parsed.type !== oldType
    if (typeChanged) {
      this._walkGridSignature = null
      this._path = null
      this._pathDistance = 0
      console.log(`[cyber-house] 要素「${row.name || id}」类型变为 ${parsed.type}：A* 栅格与进行中的路径已作废`)
    }
    console.log(`[cyber-house] 要素属性已保存：${id}（${row.source}）`)
    return { source: row.source, feature }
  }

  /**
   * 校验前端送来的属性修改包，拆成「统一字段」和「额外字段」两堆。
   *
   * @param {object} patch 原始修改包
   * @param {{shp: boolean}} opts shp=true 时 name/type 当普通字段处理
   *   （外部要素没有统一列，都是属性表里的一行）
   * @returns {{name?: string, type?: string, room?: string|null, extra: object}}
   */
  _parsePropertyPatch(patch, opts = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw patchError(400, '修改包需要是 JSON 对象，例如 {"name":"新名字","HEIGHT":30}')
    }
    const keys = Object.keys(patch)
    if (keys.length === 0) throw patchError(400, '修改包是空的，没有要改的字段')
    if (keys.length > MAX_PATCH_KEYS) throw patchError(400, `一次最多修改 ${MAX_PATCH_KEYS} 个字段`)

    const result = { extra: {} }
    for (const rawKey of keys) {
      const key = String(rawKey).trim()
      if (!key || key.length > MAX_PATCH_KEY_CHARS) {
        throw patchError(400, `字段名「${String(rawKey)}」不合法`)
      }
      if (key === 'id') throw patchError(400, 'id 是要素标识，不能修改')
      if (key.startsWith('_')) throw patchError(400, `以 _ 开头的是系统字段（${key}），不能修改`)

      const value = patch[rawKey]
      if (key === 'interact_text') {
        result.extra.interact_text = sanitizePatchValue(key, value, { interactText: true })
        continue
      }
      if (opts.shp) {
        result.extra[key] = sanitizePatchValue(key, value)
        continue
      }
      if (key === 'name') {
        const name = String(sanitizePatchValue(key, value)).trim()
        if (!name) throw patchError(400, '名称不能为空')
        result.name = name
        continue
      }
      if (key === 'type') {
        result.type = String(sanitizePatchValue(key, value)).trim().toLowerCase()
        continue
      }
      if (key === 'room') {
        result.room = value === null ? null : String(sanitizePatchValue(key, value)).trim()
        continue
      }
      result.extra[key] = sanitizePatchValue(key, value)
    }
    return result
  }

  /**
   * 按要素来源拦截「会改动几何簿记」的字段，以及跨 taxonomy 的类型变更。
   * 家具镜像（furnitureDocFromRows）读 properties.localX/localY 重建布局，
   * A* 栅格读 wkt —— 布局簿记只能从一处改，属性表这一侧不开放。
   */
  _guardPatchForSource(row, parsed) {
    const furnitureLayoutKeys = ['localX', 'localY', 'localW', 'localH', 'width', 'height']
    const doorLayoutKeys = ['x', 'y', 'width', 'height']

    if (row.type === 'door') {
      if (parsed.type && parsed.type !== 'door') {
        throw patchError(400, '门洞的 type 固定为 door')
      }
      const hit = Object.keys(parsed.extra).find((key) => doorLayoutKeys.includes(key))
      if (hit) throw patchError(400, `门洞的布局字段（${hit}）请用装修工具调整，属性表不改它`)
      return
    }

    if (row.source === 'furniture') {
      if (parsed.type && parsed.type !== 'furniture') {
        throw patchError(400, '家具的 type 固定为 furniture')
      }
      const hit = Object.keys(parsed.extra).find((key) => furnitureLayoutKeys.includes(key))
      if (hit) throw patchError(400, `家具的布局字段（${hit}）请用装修工具调整，属性表不改它`)
      return
    }

    if (row.source === 'uploaded_shp') {
      // 网页直传的 SHP：属性随便改，类型固定（改成 wall 会让 A* 把整片建筑当墙）。
      if (parsed.type && parsed.type !== 'shp_feature' && parsed.type !== 'landmark') {
        throw patchError(400, '上传 SHP 的 type 固定为 shp_feature，不能改成障碍物类型')
      }
      return
    }

    if (parsed.type && !OBSTACLE_TYPE_SET.has(parsed.type)) {
      throw patchError(400, '自建要素的 type 只能是 furniture / wall / room')
    }

    if (parsed.room !== undefined && parsed.room !== null && !ROOMS_BY_NAME[parsed.room]) {
      throw patchError(400, `room「${parsed.room}」不是已知的房间名`)
    }
  }

  /** 外部 SHP 要素的保存：合并文件属性，整条写进 shp_edits 覆盖包。 */
  async _applyShpPropertyPatch(id, patch) {
    const parsed = this._parsePropertyPatch(patch, { shp: true })
    const { loadCampusGeoJSON } = require('./campus')
    const collection = await loadCampusGeoJSON({
      coordinateSystem: 'wgs84',
      overrides: this.db.getShpEdits(),
    })
    const base = (collection.features || []).find((feature) => feature && feature.id === id)
    if (!base) {
      throw patchError(404, `没有找到外部要素「${id}」（SHP 文件里已经没有它了？）`)
    }
    const merged = Object.assign({}, base.properties || {}, parsed.extra)
    for (const key of Object.keys(merged)) {
      if (key.startsWith('_')) delete merged[key]
    }
    this.db.upsertShpEdit(id, merged)
    console.log(`[cyber-house] 外部 SHP 要素属性已保存：${id}（覆盖在文件属性之上）`)
    return {
      source: 'shp',
      feature: { ...base, properties: Object.assign({ _source: 'shp' }, merged) },
    }
  }

  /**
   * 作废 A* 栅格与进行中的平滑路径，并从数据库刷新兼容字段。
   *
   * 删除要素与添加要素在这里汇成一条路：两者的后果都是"栅格签名变了，
   * 下一轮 getState 必须重建"。单独抽出来免得两处各写一遍还漏掉谁。
   */
  _invalidateSpatialCaches(reason) {
    this.furniture = this.db.furnitureDoc()
    this.features = this.db.customFeatures()
    this._walkGrid = null
    this._walkGridSignature = null
    // 栅格变了，进行中的平滑路径可能已经失效：一并作废
    this._path = null
    this._pathDistance = 0
    console.log(`[cyber-house] 空间缓存已作废（${String(reason || '').slice(0, 60)}）：下一轮重建 A* 栅格`)
  }

  /** 当前活动对应的默认状态文案；敲门期间保留“有人敲门”。 */
  _statusForActivity(nowMs = this.now()) {
    if (this.lastKnockAt && nowMs - this.lastKnockAt >= 0 && nowMs - this.lastKnockAt < 2 * 60 * 1000) {
      return '有人敲门'
    }
    const profile = this.activity ? ACTIVITY_PROFILES[this.activity] : null
    return profile ? profile.status : DEFAULT_ACTIVITY.status
  }

  /**
   * 开始一次自主游荡：在当前房间中心附近随机取一个点，能走通才出发。
   * 返回 true 表示真的开始走了（一条平滑路径已挂好）。
   */
  _startWander(nowMs) {
    let room = ROOMS_BY_NAME[this.room] || ROOMS_BY_NAME[DEFAULT_ACTIVITY.room]
    if (!room) return false

    // 任务书 1：非小屋层级里没有「客厅 / 书房」，别让她非要往赛博小屋
    // 的房间坐标点走——围着她脚下的位置溜达，活动半径保持原来那么大。
    if (this.currentMapLevel !== DEFAULT_MAP_LEVEL) {
      const wanderSpan = 360
      room = {
        cx: this.x,
        cy: this.y,
        x: clamp(this.x - wanderSpan / 2, 0, WORLD_SIZE - wanderSpan),
        y: clamp(this.y - wanderSpan / 2, 0, WORLD_SIZE - wanderSpan),
        w: wanderSpan,
        h: wanderSpan,
      }
    }

    const margin = 20
    const maxRadius = Math.min(room.w, room.h) / 2 - margin
    if (!(maxRadius > 1)) return false
    // 至少走 2 步：新引擎比原来快得多（110 单位/秒 vs 30），游荡半径
    // 不放开一点的话，溜达瞬间就结束、网页上看不出来。
    const minRadius = Math.min(this.step * 2, maxRadius)
    const distance = minRadius + this.random() * Math.max(0, maxRadius - minRadius)
    const angle = this.random() * Math.PI * 2
    const targetX = clamp(room.cx + Math.cos(angle) * distance, room.x + margin, room.x + room.w - margin)
    const targetY = clamp(room.cy + Math.sin(angle) * distance, room.y + margin, room.y + room.h - margin)
    if (Math.hypot(targetX - this.x, targetY - this.y) < 1) return false

    const passable = this._currentWalkGrid()
    const blocked = segmentBlocked(passable, this.x, this.y, targetX, targetY)
    const route = planRoute(
      this.furniture,
      ROOMS,
      ROOMS_BY_NAME,
      this.x,
      this.y,
      targetX,
      targetY,
      { passable },
    )
    // 被挡住又找不到路：这次不游荡，下一次冷却后再抽。
    if (blocked && (!route || route.length === 0)) return false

    const finalTarget = blocked ? route[route.length - 1] : { x: targetX, y: targetY }
    const armed = this._startPathTo(finalTarget.x, finalTarget.y, 'wander', nowMs)
    if (!armed) return false

    this.isWandering = true
    this.lastWanderTime = nowMs
    return true
  }

  /**
   * 走向「所在房间的中心」：有活动时（写代码 / 刷站 / 做饭…）的目标。
   * 离中心太远才规划路径，到了就在中心附近原地小抖（保留原来的生活感）。
   *
   * 任务书 1：非小屋层级没有房间中心，只保留进行中的路径采样，
   * 不往赛博小屋的客厅坐标走（那张图里她没家）。
   */
  _approachRoomCenter(nowMs) {
    if (this.currentMapLevel !== DEFAULT_MAP_LEVEL) {
      if (this._path) this._samplePath(nowMs)
      return
    }
    const target = ROOMS_BY_NAME[this.room] || ROOMS_BY_NAME[DEFAULT_ACTIVITY.room]
    if (!target) return
    const distance = Math.hypot(this.x - target.cx, this.y - target.cy)

    // 房间换了（活动变化 / 敲门）：旧路线作废
    if (
      this._path
      && (this._path.kind === 'activity' || this._path.kind === 'idle')
      && (Math.abs(this._path.target.x - target.cx) > 0.5
        || Math.abs(this._path.target.y - target.cy) > 0.5)
    ) {
      this._path = null
      this._pathDistance = 0
    }

    if (!this._path && distance > this.step + this.jitter) {
      this._startPathTo(target.cx, target.cy, 'activity', nowMs)
    }

    if (this._path) {
      this._samplePath(nowMs)
      return
    }

    // 已在中心附近：像原来一样小抖几下，别像木头一样定住
    if (distance <= this.jitter + 1) {
      const angle = this.random() * Math.PI * 2
      const radius = this.jitter * Math.sqrt(this.random())
      this.x = clamp(target.cx + Math.cos(angle) * radius, 0, WORLD_SIZE)
      this.y = clamp(target.cy + Math.sin(angle) * radius, 0, WORLD_SIZE)
    }
  }

  /**
   * 推进一次状态，并返回 API 所需的 data 部分。
   * 这个方法应该只在 HTTP 接口被调用时触发，避免后台定时器偷偷改变时间统计。
   */
  // @doc house.api.state
  // @doc house.motion
  getState() {
    const nowMs = this.now()
    const dayKey = localDayKey(nowMs)

    if (dayKey !== this.dayKey) {
      this._resetStats(dayKey)
    }

    this._applyElapsed(nowMs)

    let snapshot = null
    try {
      snapshot = this.telemetry.read(nowMs)
      this.lastHomeError = null
    } catch (error) {
      this.lastHomeError = error instanceof Error ? error.message : String(error)
    }

    const fallback = snapshot && snapshot.home
      ? resolveHomeState(snapshot.home)
      : readHomeStateFile(this.homeFile).state

    this.room = snapshot && snapshot.room ? snapshot.room : fallback.room
    this.status = snapshot && snapshot.status ? snapshot.status : fallback.status
    this.activity = snapshot && snapshot.activity
      ? snapshot.activity
      : (ROOM_TO_ACTIVITY[this.room] || 'idle')
    this.todayUsage = snapshot && snapshot.todayUsage
      ? snapshot.todayUsage
      : emptyUsage()
    // 从校园传送回客厅后的两分钟：idle 遥测不该立刻把她拉回阳台。
    if (this.currentEnvironment === 'home' && nowMs < this._homeTeleportUntil) {
      this.room = '客厅'
      this.status = '在家休息'
    }
    this.systemHealth = readSystemHealth(this.workspaceRoot)
    // 从数据库取一次快照：家具 / 门洞 / 自建要素都在这批行里。
    // revision 没变时 snapshot() 直接命中缓存，不会每 2 秒重新解析 WKT。
    //
    // 任务书 1「按地图层级隔离」：快照只取当前 map_level 的行——
    // 切到 village 后 /state 返回的就是 village 那一张图的全部内容，
    // 赛博小屋的家具 / 墙不会混进来，前端拿到什么就画什么。
    const currentLevel = this.currentMapLevel
    const spatial = this.db.snapshotForLevel(currentLevel)
    this.furniture = spatial.furnitureDoc
    this.features = spatial.customFeatures
    // 动态属性表：把屋内要素（自建 + 家具）每个都带全属性、带来源标识
    // 组成一张 FeatureCollection，网页面板按 feature.properties 的所有 key
    // 动态生成输入框。门洞是系统要素，不进属性表。
    const featureRows = []
    for (const row of spatial.customRows || []) {
      if (row) featureRows.push(this.db.rowToFeature(row))
    }
    for (const row of spatial.furnitureRows || []) {
      if (row) featureRows.push(this.db.rowToFeature(row))
    }
    // 网页直传的 SHP：也进属性表（带 _source: 'uploaded_shp'），
    // 但不参与 A* —— 它们的 type 固定 shp_feature。
    for (const row of spatial.uploadedRows || []) {
      if (row) featureRows.push(this.db.rowToFeature(row))
    }

    // 网页敲门后的两分钟内，直接视为“正在客厅回话”，让她立刻游过来。
    if (this.lastKnockAt && nowMs - this.lastKnockAt >= 0 && nowMs - this.lastKnockAt < 2 * 60 * 1000) {
      this.room = ACTIVITY_PROFILES.qq.room
      this.activity = 'qq'
      this.status = '有人敲门'
    }

    // ---- 移动（任务书「60帧丝滑移动引擎」模块 2）：position = f(时间) ----
    // 用户点了终点：赶路途中目的地优先，不管遥测里是什么活动。
    // 只有“已经到了”且真实活动（非 idle）出现时，才让位给活动推断。
    const inferredRoom = this.room
    const inferredStatus = this.status
    let manualHandled = false
    if (this._userDestination) {
      this.isWandering = false
      this.room = this._userDestinationRoom || this.room

      // 没挂路线就规划一条（setDestination 一般已经规划好了；这里兜住
      // 空间缓存作废 / 空间切换把 _path 打掉、以及「到达后 activity≠idle
      // 让位」回退等情形）。已经到达就不再重复规划。
      if (!this._path && !this._userDestinationArrived) {
        const armed = this._startPathTo(
          this._userDestination.x,
          this._userDestination.y,
          'user',
          nowMs,
        )
        if (!armed) this._userDestinationArrived = true
      } else if (this._path) {
        const sample = this._samplePath(nowMs)
        if (sample && sample.done) {
          // 缓动把她稳稳放在终点上
          this._userDestinationArrived = true
          this.lastWanderTime = nowMs
        } else if (!this._userDestinationArrived) {
          const distance = Math.hypot(
            this.x - this._userDestination.x,
            this.y - this._userDestination.y,
          )
          if (distance <= this.jitter + 1) {
            this._userDestinationArrived = true
            this._path = null
            this._pathDistance = 0
            this.lastWanderTime = nowMs
          }
        }
      }

      if (this._userDestinationArrived && this.activity !== 'idle') {
        // 到了以后有真实活动：放弃手动终点，交给下面的活动分支。
        this._userDestination = null
        this._userDestinationRoom = null
        this._userDestinationArrived = false
        this._path = null
        this._pathDistance = 0
        this.room = inferredRoom
        this.status = inferredStatus
      } else {
        this.status = this._userDestinationArrived
          ? this._statusForActivity(nowMs)
          : '前往目的地'
        manualHandled = true
      }
    }

    // 校园模式没有用户终点时，不把小屋的 activity/room 当成移动目标——
    // 否则去武大后会立刻被“客厅中心”拽回去。校园里先停在传送点，
    // 等用户点地图规划真实路线。
    const campusHold = this.currentEnvironment === 'campus' && !this._userDestination
    // 刚从小屋传送回来也先站定两分钟，别让遥测立刻把她从客厅拉走。
    const homeHold = this.currentEnvironment === 'home' && !this._userDestination && nowMs < this._homeTeleportUntil

    // 定身期：进行中的路线一并作废，前端那边也会看到空点阵而停下
    if ((campusHold || homeHold) && this._path) {
      this._path = null
      this._pathDistance = 0
    }

    if (!manualHandled && !campusHold && !homeHold && this.activity === 'idle') {
      // 空闲且没有用户终点：每 10 秒左右在房间中心附近散一次步。
      if (!this.isWandering) {
        if (!this.lastWanderTime) {
          this.lastWanderTime = nowMs
        } else if (nowMs - this.lastWanderTime > 10000) {
          // 找不到路也算一次尝试，等下一个冷却再抽，避免每 2 秒重试一次。
          if (!this._startWander(nowMs)) this.lastWanderTime = nowMs
        }
      }

      if (this.isWandering && this._path) {
        const sample = this._samplePath(nowMs)
        if (!sample || sample.done) {
          this.isWandering = false
          this._path = null
          this._pathDistance = 0
          this.lastWanderTime = nowMs
        }
      } else {
        this.isWandering = false
      }

      if (this.isWandering) {
        this.status = '四处溜达'
      } else {
        this.status = this._statusForActivity(nowMs)
        this._approachRoomCenter(nowMs)
      }
    } else if (!manualHandled && !campusHold && !homeHold) {
      // 有真实活动（写代码 / 刷站 / QQ / 做饭 / 休息）：走房间中心，不游荡。
      // 敲门等「活动突然变化」时，手头的溜达路径当场作废，立刻转向新目标。
      if (this._path && this._path.kind === 'wander') {
        this._path = null
        this._pathDistance = 0
      }
      this.isWandering = false
      this.lastWanderTime = nowMs
      this._approachRoomCenter(nowMs)
    }

    // 移动完成后再判交互：这一轮真的走到宝箱 / 床 / 电脑旁边时才会触发。
    const interaction = this._updateInteractions(nowMs, spatial)
    // NPC 也在同一轮里溜达；到点抽到对白会写 events 并挂气泡。
    const npcs = this._updateNpcs(nowMs)

    const todayStats = emptyStats()
    for (const room of ROOMS) {
      todayStats[room.name] = Math.round(this.statsExact[room.name] || 0)
    }

    // 当前空间 + 真实坐标（任务书 3）：校园模式下前端直接用 geoGcj02 贴瓦片。
    const geoPosition = this.getGeoPosition()
    // 跨空间认知（任务书「修复跨空间认知同步」）：
    // campus 时 room 换成最近 POI，status 换成校园状态；home 时保留小屋房间。
    let displayRoom = this.room
    let displayStatus = this.status
    let displayActivity = this.activity
    let campusPoi = null
    if (this.currentEnvironment === 'campus') {
      campusPoi = nearestCampusPoi(this.x, this.y, this.campusPois)
      displayRoom = campusPoi ? campusPoi.name : '武汉大学'
      displayStatus = campusStatusFor(campusPoi)
      displayActivity = 'campus'
    } else if (nowMs < this._homeTeleportUntil) {
      displayRoom = '客厅'
      displayStatus = '在家休息'
    }
    this._writeSpaceContext({
      nowMs,
      room: displayRoom,
      status: displayStatus,
      poi: campusPoi,
    })
    return {
      room: displayRoom,
      status: displayStatus,
      activity: displayActivity,
      homeRoom: this.room,
      homeStatus: this.status,
      environment: this.currentEnvironment,
      // 任务书 1「多层级地图底座」：当前地图层级、数据库里已有的全部层级、
      // 这一层地图的边界（前端下拉框 + 切图后 map.fitBounds() 用）。
      mapLevel: currentLevel,
      mapLevels: this.db.listMapLevels(),
      mapBounds: spatial.bounds,
      campusPoi: campusPoi
        ? {
            name: campusPoi.name,
            kind: campusPoi.kind,
            distance: Math.round(Number(campusPoi.distance) || 0),
          }
        : null,
      geo: geoPosition.geo,
      geoGcj02: geoPosition.geoGcj02,
      virtual: geoPosition.virtual,
      campusBBox: geoPosition.bbox,
      campusCenter: geoPosition.center,
      position: {
        x: Math.round(this.x * 10) / 10,
        y: Math.round(this.y * 10) / 10,
      },
      currentRoute: this.currentRoute(),
      // 任务书模块 2：时间驱动的平滑移动三件套。
      // 前端拿到 points + pathStart + pathDuration 就用 requestAnimationFrame
      // 沿贝塞尔点阵自行播放（缓动函数与后端同款），不再等 2 秒轮询推坐标。
      smoothPath: this._path
        ? this._path.points.map((point) => ({
          x: roundCoordinate(point.x),
          y: roundCoordinate(point.y),
        }))
        : [],
      pathStart: this._path ? this._path.startedAt : null,
      pathDuration: this._path ? this._path.duration : 0,
      // 拓扑检查同层级隔离：village 的墙压到 cyber_house 的沙发上不算冲突
      topologyErrors: this.checkTopology(currentLevel),
      todayStats,
      todayUsage: {
        turns: Math.max(0, Math.round(Number(this.todayUsage.turns) || 0)),
        tokens: Math.max(0, Math.round(Number(this.todayUsage.tokens) || 0)),
        inputTokens: Math.max(0, Math.round(Number(this.todayUsage.inputTokens) || 0)),
        outputTokens: Math.max(0, Math.round(Number(this.todayUsage.outputTokens) || 0)),
        cacheReadTokens: Math.max(0, Math.round(Number(this.todayUsage.cacheReadTokens) || 0)),
        cacheWriteTokens: Math.max(0, Math.round(Number(this.todayUsage.cacheWriteTokens) || 0)),
      },
      systemHealth: this.systemHealth,
      furniture: this.furniture,
      // 网页上画的自定义要素：前端按 properties.type 符号化渲染，
      // wall / furniture 会同时计入 A* 障碍栅格（见 _currentWalkGrid）。
      customFeatures: this.features,
      // 网页直传的 SHP：前端单独一层画出来（坐标已经换算到 0–1000），
      // 点击走与校园要素同一套动态属性面板。不进 A* 障碍栅格。
      uploadedFeatures: spatial.uploadedFeatures || {
        type: 'FeatureCollection',
        name: '赛博小屋·上传 SHP',
        features: [],
      },
      // 动态属性表的统一数据源：屋内全部要素（自建 + 家具 + 网页直传的 SHP）的
      // 完整属性，properties._source 标记来源（custom / furniture / uploaded_shp）。
      // 校园 SHP 文件里的要素不在这里（由 /campus-geojson 单独拉取）。
      featureRows: {
        type: 'FeatureCollection',
        name: '赛博小屋·全部要素',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
        features: featureRows,
      },
      // 场景交互（任务书 1）：当前应该在地图上冒出的对话气泡。
      // 每个气泡带 center/expiresAt；过期或小鱼走远后后端会自然不再返回。
      interactionBubbles: interaction.bubbles,
      interactions: {
        triggered: interaction.triggered.length,
        reset: interaction.reset.length,
        lastAt: this.lastInteractionAt || null,
      },
      // 两个 NPC：位置 / Emoji / 房间 / 当前头顶气泡。
      npcs,
      npcDialogue: this._lastNpcDialogue
        ? {
            id: this._lastNpcDialogue.id,
            at: this._lastNpcDialogue.at,
            lines: this._lastNpcDialogue.lines,
          }
        : null,
      // 存储层自检信息：前端不依赖它，验收 / 排查时能直接看到 SQLite 是否启用、
      // SpatiaLite 是否加载、各类要素各有多少。
      storage: this.db.info(),
    }
  }

  /**
   * 把小屋导出成 RFC 7946 GeoJSON。几何组装在 gis/geojson.js。
   *
   * 导出走的是全库快照（所有层级一起），/state 才按层级过滤——
   * GET /geojson 的契约是「同一份数据导进 QGIS」，导入时 properties.map_level
   * 会让每条要素各自回到自己的层级。
   */
  getHouseGeoJSON() {
    const snapshot = this.db.snapshot()
    return buildHouseGeoJSON(
      this.getState(),
      snapshot.furnitureDoc,
      ROOMS,
      ROOMS_BY_NAME,
      snapshot.customFeatures,
    )
  }
}

function createStateEngine(options) {
  return new FishHomeStateEngine(options)
}

module.exports = {
  WORLD_SIZE,
  GRID_CELLS,
  CELL_SIZE,
  DEFAULT_STEP,
  DEFAULT_JITTER,
  DEFAULT_MAP_LEVEL,
  PHYSICAL_EVENT_TTL_MS,
  PHYSICAL_EVENT_MAX_FILES,
  ROOMS,
  ROOMS_BY_NAME,
  ACTIVITY_PROFILES,
  DEFAULT_ACTIVITY,
  DEFAULT_ACTIVITY_WINDOWS,
  ROOM_TO_ACTIVITY,
  resolveHomeState,
  resolveActivity,
  resolveRoom,
  readHomeStateFile,
  checkTopology: checkTopologyPure,
  normalizeMapLevel,
  // 校园真实地理映射（任务书 3）
  CAMPUS_BBOX,
  CAMPUS_CENTER,
  virtualToGeo,
  geoToVirtual,
  virtualToGcj02,
  gcj02ToVirtual,
  defaultDshRoot,
  defaultFishRoot,
  defaultHomeFile,
  defaultWorkspaceRoot,
  defaultFurnitureFile,
  readFurnitureFile,
  writeFurnitureFile,
  defaultFeaturesFile,
  readFeaturesFile,
  writeFeaturesFile,
  readSystemHealth,
  FishTelemetry,
  FishHomeStateEngine,
  createStateEngine,
}
