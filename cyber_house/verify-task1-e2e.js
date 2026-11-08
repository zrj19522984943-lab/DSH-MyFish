'use strict'
// 任务书 1「多层级地图底座与 QGIS 数据无缝接入」—— 验收清单脚本。
// 用法：先启动 node api-router.js，再 node verify-task1-e2e.js。
// 对应任务书的验证清单：导入含 map_level:'village' 的 GeoJSON；
// 切到 village 能看到导入的地形且赛博小屋家具全部消失；
// 小鱼在 village 里走动时能正确避开 village 里的墙。
// 脚本自带清理：跑完会把导入的要素全部删掉，环境恢复原样，可反复运行。
const http = require('node:http')

const PORT = Number(process.env.FISH_HOME_PORT || 8787)

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { Accept: 'application/json' }
    if (data) headers['Content-Type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = null
        try { payload = JSON.parse(text) } catch { /* keep null */ }
        resolve({ status: res.statusCode, payload, text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// 断言助手
let failures = 0
function check(label, ok, detail) {
  const line = (ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  [' + String(detail).slice(0, 140) + ']' : '')
  console.log(line)
  if (!ok) failures += 1
}

async function main() {
  // ---- 0. 基线：小屋层（显式带上 map_level，引擎当前层级可能停在别处） ----
  let res = await request('GET', '/api/fish-home/state?map_level=cyber_house')
  check('GET /state 200', res.status === 200, res.status)
  const homeState = res.payload && res.payload.data
  check('基线 mapLevel = cyber_house', homeState && homeState.mapLevel === 'cyber_house')
  const homeFurnitureCount = homeState
    ? Object.values(homeState.furniture.rooms).reduce((a, r) => a + (r.items ? r.items.length : 0), 0) : 0
  check('小屋层有家具', homeFurnitureCount > 0, '家具数 ' + homeFurnitureCount)
  check('小屋层 mapBounds 是整张世界', homeState && JSON.stringify(homeState.mapBounds) === '[0,0,1000,1000]', homeState && homeState.mapBounds)

  // ---- 1. 导入含 map_level: 'village' 的 GeoJSON ----
  const villageGeoJSON = {
    type: 'FeatureCollection',
    name: '村庄（QGIS 导出）',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [
      // 一堵横墙，右侧 x>700 留缝
      { type: 'Feature', properties: { type: 'wall', name: '北木墙', map_level: 'village' }, geometry: { type: 'LineString', coordinates: [[40, 220], [700, 220]] } },
      // 一栋房子（MultiPolygon，验收拆分）
      {
        type: 'Feature', id: 'vil-house',
        properties: { type: 'wall', name: '村长家', map_level: 'village' },
        geometry: { type: 'MultiPolygon', coordinates: [[[[380, 560], [620, 560], [620, 680], [380, 680], [380, 560]]], [[[380, 680], [620, 680], [620, 760], [380, 760], [380, 680]]]] },
      },
      // 水井（家具/障碍）
      { type: 'Feature', properties: { type: 'furniture', name: '水井', icon: '⛲', map_level: 'village' }, geometry: { type: 'Point', coordinates: [150, 420] } },
      // 地形（无 type => 只展示的 shp_feature）
      { type: 'Feature', properties: { name: '麦田', map_level: 'village' }, geometry: { type: 'Polygon', coordinates: [[[80, 60], [320, 60], [320, 160], [80, 160], [80, 60]]] } },
      // 带 props_json 长串的要素
      { type: 'Feature', properties: { props_json: JSON.stringify({ type: 'room', name: '酒馆' }), map_level: 'village' }, geometry: { type: 'Polygon', coordinates: [[[720, 300], [900, 300], [900, 420], [720, 420], [720, 300]]] } },
      // 非法层级名：应该被跳过并报错，而不是静默进 cyber_house
      { type: 'Feature', properties: { type: 'wall', map_level: 'Bad Level' }, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } },
      // 没带 map_level 的要素：默认 cyber_house
      { type: 'Feature', properties: { type: 'wall', name: '小屋边的栅栏' }, geometry: { type: 'LineString', coordinates: [[940, 940], [980, 980]] } },
    ],
  }
  res = await request('POST', '/api/fish-home/import-qgis', villageGeoJSON)
  check('POST /import-qgis 200', res.status === 200, res.status + ' ' + String(res.text).slice(0, 120))
  const importData = res.payload && res.payload.data
  check('导入 7 个要素（6 village + 1 缺省，1 条非法层级被跳过）', importData && importData.imported === 7, importData && importData.imported)
  check('错误列表 1 条（非法层级）', importData && importData.errors.length === 1, JSON.stringify(importData && importData.errors))
  check('层级统计含 village', importData && importData.levelCounts && importData.levelCounts.village === 6, JSON.stringify(importData && importData.levelCounts))
  check('层级统计含 cyber_house（缺省栅栏）', importData && importData.levelCounts && importData.levelCounts.cyber_house === 1, JSON.stringify(importData && importData.levelCounts))
  check('mapLevels 含 village', importData && importData.mapLevels.includes('village'), JSON.stringify(importData && importData.mapLevels))
  check('MultiPolygon 拆成 2 个（vil-house / vil-house-0 / -1）', importData && importData.ids.some((id) => id === 'vil-house-0') && importData.ids.some((id) => id === 'vil-house-1'), JSON.stringify(importData && importData.ids))

  // ---- 2. 切到 village：看地形、小屋家具消失 ----
  res = await request('GET', '/api/fish-home/state?map_level=village')
  check('GET /state?map_level=village 200', res.status === 200, res.status)
  const villageState = res.payload && res.payload.data
  check('mapLevel = village', villageState && villageState.mapLevel === 'village')
  const villageFurniture = villageState
    ? Object.values(villageState.furniture.rooms).reduce((a, r) => a + (r.items ? r.items.length : 0), 0) : 0
  check('village 层没有赛博小屋家具', villageFurniture === 0, '家具数 ' + villageFurniture)
  const customNames = (villageState && villageState.customFeatures ? villageState.customFeatures.features : []).map((f) => f.properties.name)
  check('village 层有导入的地形（北木墙/村长家/水井/麦田/酒馆）', ['北木墙', '村长家', '水井', '麦田', '酒馆'].every((n) => customNames.includes(n)), JSON.stringify(customNames))
  check('village 层 featureRows 只有这一层的要素', villageState && villageState.featureRows.features.length === 6, (villageState && villageState.featureRows.features.length))
  check('village 层 mapBounds 在导入要素范围内', villageState && villageState.mapBounds[0] <= 40 && villageState.mapBounds[2] >= 900, JSON.stringify(villageState && villageState.mapBounds))
  // 酒馆是 room 类型：栅格化出可通行格
  check('village 层上传 SHP 隔离为空', villageState && villageState.uploadedFeatures.features.length === 0)

  // 回到小屋：家具回来，village 要素消失
  res = await request('GET', '/api/fish-home/state?map_level=cyber_house')
  const homeAgain = res.payload && res.payload.data
  const homeAgainFurniture = homeAgain
    ? Object.values(homeAgain.furniture.rooms).reduce((a, r) => a + (r.items ? r.items.length : 0), 0) : 0
  check('回到小屋层：家具回来', homeAgainFurniture === homeFurnitureCount, '家具数 ' + homeAgainFurniture)
  const homeCustomNames = (homeAgain.customFeatures.features || []).map((f) => f.properties.name)
  check('小屋层看不到 village 地形', !homeCustomNames.includes('北木墙') && !homeCustomNames.includes('村长家'), JSON.stringify(homeCustomNames))
  check('小屋层看到缺省栅栏（map_level=cyber_house）', homeCustomNames.includes('小屋边的栅栏'), JSON.stringify(homeCustomNames))

  // ---- 3. A* 寻路避墙：小鱼在 village 里从墙南走到墙北 ----
  res = await request('GET', '/api/fish-home/state?map_level=village')
  const stateBefore = res.payload && res.payload.data
  const startX = stateBefore.position.x
  const startY = stateBefore.position.y
  console.log('  小鱼当前位置: (' + startX + ', ' + startY + ')')
  // 先把小鱼挪到墙的南边 (360, 600)，等她真的走到（含绕路时间）
  res = await request('POST', '/api/fish-home/destination', { x: 360, y: 600 })
  check('设置村内起点 (360,600)', res.status === 200 && res.payload.ok === true, res.status)
  let pos = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    res = await request('GET', '/api/fish-home/state?map_level=village')
    pos = res.payload && res.payload.data && res.payload.data.position
    if (pos && pos.y > 350) break
  }
  console.log('  到达村内起点: (' + pos.x + ', ' + pos.y + ')')
  check('已到达墙南（y > 350，可以开始跨墙测试）', pos && pos.y > 350, `(${pos && pos.x}, ${pos && pos.y})`)
  // 再点到墙的北边 (360, 60)：直线会压在 y≈220 的墙上，必须绕行
  res = await request('POST', '/api/fish-home/destination', { x: 360, y: 60 })
  const plan = res.payload && res.payload.data
  check('规划村内路线 (360,600)->(360,60)', res.status === 200 && plan.ok === true, res.status)
  const smooth = plan.smoothPath || []
  check('路径起点在墙南', smooth.length > 0 && smooth[0].y > 350, smooth.length && smooth[0])
  check('路径终点在墙北', smooth.length > 1 && smooth[smooth.length - 1].y < 150, smooth.length && smooth[smooth.length - 1])
  // 压在墙段（40≤x≤700, y≈220）上的点必须为 0 —— 墙的两端是开口，
  // 从 x<40 或 x>700 绕过去都算正确避墙
  let wallHits = 0
  for (const point of smooth) {
    if (Math.abs(point.y - 220) < 8 && point.x >= 40 && point.x <= 700) wallHits += 1
  }
  check('平滑路径不穿墙（压在 40≤x≤700, y≈220 上的点数 = 0）', wallHits === 0, '击中点数 ' + wallHits)
  let houseHits = 0
  for (const point of smooth) {
    if (point.x > 385 && point.x < 615 && point.y > 565 && point.y < 755) houseHits += 1
  }
  check('平滑路径不穿房子', houseHits === 0, '击中点数 ' + houseHits)
  let detouredAt = null
  for (const point of smooth) {
    if (Math.abs(point.y - 220) < 30 && (point.x < 40 || point.x > 700)) { detouredAt = point; break }
  }
  check('路径绕过墙的某一端（y≈220 附近存在 x<40 或 x>700 的点）', Boolean(detouredAt), detouredAt ? `(${detouredAt.x}, ${detouredAt.y})` : '路径 x 范围 ' + (smooth.length ? Math.min(...smooth.map((p) => p.x)).toFixed(0) + '..' + Math.max(...smooth.map((p) => p.x)).toFixed(0) : '-'))
  // 走几步，确认她真的在动且没穿墙
  await new Promise((resolve) => setTimeout(resolve, 3000))
  res = await request('GET', '/api/fish-home/state?map_level=village')
  pos = res.payload && res.payload.data && res.payload.data.position
  console.log('  行进中位置: (' + pos.x + ', ' + pos.y + ')')
  check('小鱼在 village 里移动了（离起点 > 30）', Math.hypot(pos.x - 360, pos.y - 600) > 30, `(${pos.x}, ${pos.y})`)

  // ---- 4. 重复导入 = 覆盖；非法请求体报错 ----
  res = await request('POST', '/api/fish-home/import-qgis', villageGeoJSON)
  check('重复导入按 id 覆盖，数量不变', res.status === 200 && res.payload.data.imported === 7, res.status)
  res = await request('POST', '/api/fish-home/import-qgis', { hello: 1 })
  check('非法请求体 400', res.status === 400, res.status + ' ' + String(res.text).slice(0, 80))
  res = await request('POST', '/api/fish-home/import-qgis', { type: 'FeatureCollection', features: [] })
  check('空 features 400', res.status === 400, res.status)
  res = await request('POST', '/api/fish-home/import-qgis', {
    type: 'FeatureCollection',
    map_level: 'forest',
    features: [{ type: 'Feature', properties: { type: 'wall' }, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } }],
  })
  check('请求体顶层 map_level 缺省生效（forest）', res.status === 200 && res.payload.data.levelCounts.forest === 1, JSON.stringify(res.payload && res.payload.data && res.payload.data.levelCounts))

  // ---- 清理：删掉本次导入的所有要素，让环境回到原样 ----
  const ids = importData ? importData.ids : []
  for (const id of ids) {
    await request('DELETE', '/api/fish-home/features/' + encodeURIComponent(id))
  }
  // sweep：连同历次残留的 qgis-* / vil-* 一并清掉（GET /features 返回全部层级）
  res = await request('GET', '/api/fish-home/features')
  const allCustom = (res.payload && Array.isArray(res.payload.features)) ? res.payload.features : []
  for (const feature of allCustom) {
    const id = String(feature.id || '')
    if (id.startsWith('qgis-') || id.startsWith('vil-')) {
      await request('DELETE', '/api/fish-home/features/' + encodeURIComponent(id))
    }
  }
  res = await request('GET', '/api/fish-home/state?map_level=cyber_house')
  const finalState = res.payload && res.payload.data
  const finalNames = (finalState.customFeatures.features || []).map((f) => f.properties.name)
  check('清理后小屋层恢复原样（只剩原有自建要素）', !finalNames.some((n) => ['北木墙', '村长家', '水井', '麦田', '酒馆', '小屋边的栅栏'].includes(n)), JSON.stringify(finalNames))
  check('清理后 mapLevels 只剩 cyber_house', finalState.mapLevels.length === 1 && finalState.mapLevels[0] === 'cyber_house', JSON.stringify(finalState.mapLevels))

  console.log('')
  console.log(failures === 0 ? '✅ 全部验收通过' : `❌ ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本异常:', error)
  process.exit(2)
})
