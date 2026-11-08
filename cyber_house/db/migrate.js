#!/usr/bin/env node
'use strict'

/**
 * db/migrate.js —— 空间数据库命令行工具
 *
 * 用法：
 *   node cyber_house/db/migrate.js                 查看数据库状态（空库会自动迁移）
 *   node cyber_house/db/migrate.js --status        只打印状态
 *   node cyber_house/db/migrate.js --list          打印全部要素行
 *   node cyber_house/db/migrate.js --check         跑一次拓扑检查
 *   node cyber_house/db/migrate.js --force         清空 features 表后从旧 JSON 重新迁移
 *   node cyber_house/db/migrate.js --db <path>     指定数据库文件
 *
 * 迁移是幂等的：数据库里已有数据时默认直接跳过，不会覆盖运行中的小屋。
 * --force 会先备份 furniture.json / features.json，再重建 features 表。
 */

const path = require('node:path')

const { openDatabase, defaultWorkspaceRoot } = require('./index')
const { checkTopology } = require('../gis/topology')

function parseArgs(argv) {
  const options = {
    workspaceRoot: defaultWorkspaceRoot(),
    dbFile: null,
    force: false,
    status: false,
    list: false,
    check: false,
  }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') options.force = true
    else if (arg === '--status') options.status = true
    else if (arg === '--list') options.list = true
    else if (arg === '--check') options.check = true
    else if (arg === '--db') {
      options.dbFile = argv[index + 1] ? path.resolve(argv[index + 1]) : null
      index += 1
    } else if (arg === '--workspace') {
      options.workspaceRoot = path.resolve(argv[index + 1] || options.workspaceRoot)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node cyber_house/db/migrate.js [--status|--list|--check|--force] [--db <path>]')
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      process.exit(2)
    }
  }
  return options
}

// @doc house.db-schema
function main() {
  const options = parseArgs(process.argv)
  const store = openDatabase({
    workspaceRoot: options.workspaceRoot,
    dbFile: options.dbFile || undefined,
    fresh: true,
  })

  try {
    if (options.force) {
      console.log('[migrate] --force：清空 features 表并从旧 JSON 重新导入……')
      const result = store.migrateFromJson({ force: true })
      console.log(`[migrate] 完成：${result.count} 行（家具 ${result.furniture}、门 ${result.doors}、自定义 ${result.custom}）`)
    }

    const info = store.info()
    console.log(JSON.stringify(info, null, 2))

    if (options.list) {
      console.log('\nid\ttype\troom\tname\twkt')
      for (const row of store.listRows()) {
        console.log(`${row.id}\t${row.type}\t${row.room || ''}\t${row.name}\t${row.wkt}`)
      }
    }

    if (options.check) {
      const errors = checkTopology(store)
      console.log(`\n[topology] ${errors.length} 处冲突`)
      for (const [index, error] of errors.entries()) {
        console.log(`${index + 1}. [${error.type}] ${error.message}`)
      }
    }

    if (!options.status && !options.list && !options.check && !options.force) {
      console.log('\n提示：--list 看全部行，--check 跑拓扑检查，--force 从旧 JSON 重建。')
    }
  } finally {
    store.close()
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[migrate] 失败：${error?.message || error}`)
    process.exitCode = 1
  }
}

module.exports = { parseArgs }
