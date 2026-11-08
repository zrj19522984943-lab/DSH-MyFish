owner: ops.config-write
anchors: packaging/setup.js#main; packaging/setup.js#QQ_KEYS; packaging/setup.js#fishConfigFile; packaging/setup.js#qqSettingsFile; packaging/setup.js#writeJson
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# ops.config-write

本文档是 `ops.config-write` 的唯一事实来源：发布包里的 `packaging/setup.js` 如何把解压目录的 `config.json` 写到系统真正读取的两个位置、做了哪些规范化和备份。安装步骤本身见 `ops.install`，发布包布局见 `ops.layout`。

## 事实

### 输入与输出

`setup.js` 以自身所在目录 `ROOT = __dirname` 为基准，读 `ROOT/config.json`。它只写两个文件：

| 目标 | 路径 | 内容 |
| --- | --- | --- |
| fish | `$DSH_FISH_HOME` 或 `~/.dsh-fish` 下的 `config.json` | fish 段（整份模板去掉 `qq` 与 `_说明`） |
| qq | `$DSH_HOME` 或 `~/.dsh` 下的 `qq-bridge-settings.json` | `{ version: 1, values: {...} }`，只含 43 个 `QQ_KEYS` |

路径函数：

- `fishHome()` = `path.resolve(process.env.DSH_FISH_HOME || path.join(os.homedir(), '.dsh-fish'))`；
- `dshHome()` = `path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))`；
- 目标文件名固定为 `config.json` 与 `qq-bridge-settings.json`。

### fish 段的处理

1. 深拷贝整份 `config.json`；
2. 删除 `_说明` 与 `qq` 两个顶层键；
3. `fish.work` 确保是对象，`work.enabled = fish.work.enabled !== false`（默认开），`work.dir = ROOT`（解压目录的绝对路径）；
4. 重置三个运行态字段：`notify.lastShown = ''`、`comment.lastScanAt = ''`、`ui.ownerHintDismissed = false`；
5. 递归删除字符串占位符（`/^YOUR_[A-Z0-9_]+_HERE$/`）；
6. 备份旧 `config.json`（存在时）为 `config.json.bak-<ISO 时间戳>`，再以 0600 权限原子写入（`.tmp` + `rename`）。

### qq 段的处理

1. 只从模板的 `qq` 对象里取 `QQ_KEYS`（**43 个**键；不在名单里的键不会写过去）：`qqNumber`、`ownerQQ`、`nicknames`、`whitelist`、`admins`、`groupWhitelist`、`onebotUrl`、`onebotPort`、`accessTokenEnv`、`selfId`、`replyMode`、`replyWithQuote`、`atOnlyInGroup`、`stripMarkdown`、`proactiveEnabled`、`proactiveProbability`、`proactiveDailyLimit`、`proactiveIdleHours`、`proactiveScanIntervalMinutes`、`subsendEnabled`、`subsendDailyLimit`、`subsendCooldownSeconds`、`idleTriggerEnabled`、`idleTriggerScanIntervalMinutes`、`idleTriggerMinIdleHours`、`idleTriggerDailyMax`、`idleTriggerWeightSilent`、`idleTriggerWeightMessage`、`idleTriggerWeightBrowse`、`idleTriggerWeightDiary`、`checklogNotifyMode`、`checklogNotifyOnSuccess`、`checklogNotifyDailyLimit`、`checklogNotifyTarget`、`envSensorEnabled`、`envWeatherCity`、`envSensorTime`、`envMemoryThreshold`、`workspaceRoot`、`targetSessionId`、`napcatInstallDir`、`napcatVersion`、`downloadProxy`。
2. `ownerQQ` / `qqNumber` 只保留数字；必须满足 `/^\d{5,12}$/`，否则删除该键。
3. `whitelist` / `admins` / `groupWhitelist` 做去重 + 只留合法 QQ 号；如果配了主人，把主人**插到白名单最前面**；`admins` 里去掉主人（主人不重复占管理员位）。
4. `workspaceRoot = ROOT`（解压目录绝对路径）。
5. `envWeatherCity` 如果还是占位符 → 改成 `'北京'`（有意的默认值，不是透传）。
6. 删除空的 `pipelineWorkerApi` / `pipelineWorkerKey` / `targetSessionId` / `napcatInstallDir`；`accessTokenEnv` 空则保留空串（表示不启用 token）；`onebotUrl` 的占位符删除，空串保留（表示不启用传输）。
7. **没配 `ownerQQ` 时只更新 `workspaceRoot`**：`qqWrite = { ...existingValues, workspaceRoot: ROOT }`，不会把用户已有的其他 qq 设置清空；配了主人才把本次 `qq` 整段合并进旧值。
8. 备份旧 `qq-bridge-settings.json`（存在时）为 `*.bak-<ISO 时间戳>`，再以 0600 权限原子写入 `{ version: 1, values: qqWrite }`。

### 运行模式与退出

- `node setup.js`：正常写入；成功打印 `✔ 配置已写入`，并列出备份路径与下一步。
- `node setup.js --dry-run`：只打印 fish / qq 两份预览，不落盘。
- `node setup.js --help` / `-h`：打印用法与两个目标路径。
- 找不到 `config.json`、JSON 非法、最外层不是对象：打印中文原因并设 `process.exitCode = 1`，不写任何文件。
- 不联网、不上传；只写上面两个文件，不改插件代码。

### 已知偏差

- `README-RELEASE.md` §2 第 3 步说「把 `config.json` 里的 fish 段写入…把 qq 段合并进…」；代码实际写入的是**整份模板去掉 `qq` 与 `_说明`**（fish 段是主体，但顶层其他键也会进 fish 配置），qq 段只取 **43 个 `QQ_KEYS`**，不是整段透传。
- README 让用户填 `qq.pipelineWorkerKey`（可选）；但 `QQ_KEYS` **不包含** `pipelineWorkerApi` / `pipelineWorkerKey`，`setup.js` 不会把它们写进 `qq-bridge-settings.json`。这是原文档与 `setup.js` 的真实差异，保留给 T4 统一处理。
- README 说「它会做三件事」（fish 写入、qq 合并、填 `work.dir` / `workspaceRoot`）；代码还做了：QQ 号清洗与 5–12 位校验、白名单去重并把主人放最前、管理员去主人、占位符清理、`envWeatherCity` 占位符 → 北京、旧文件备份、0600 权限、原子写。
- README 说「重复运行是安全的」；严格说 fish 配置会被整份覆盖（先备份），qq 配置在配了主人时是合并、没配主人时只覆盖 `workspaceRoot`。安全来自备份与合并策略，不是「完全不动旧值」。
- README 说「旧文件会先备份成 `*.bak-时间戳`」；时间戳是 `toISOString()` 后把 `:` / `.` 换成 `-`，不是本地时间格式。
- README 的 `work.dir` 说明正确：`setup.js` 把 `fish.work.dir` 设为 `ROOT`；`qq.workspaceRoot` 也设为同一个 `ROOT`，README 只在目录说明里提了 `workspaceRoot`，没有强调两者同源。
- `config.example.json` 是发布包生成物，不在本仓库根目录；`setup.js` 只读 `config.json`，不会替你复制模板。

## 不负责

- 五步安装流程、解压 / 依赖 / 导入插件 / 启动后端 → 见 `ops.install`。
- 发布包目录布局与「包里没有什么」 → 见 `ops.layout`。
- 打包时的黑名单、脱敏与残留扫描 → 见 `ops.release`。
- 哪些数据是本机私密、不要分享 → 见 `ops.privacy`。
- 运行期 fish / qq 配置如何被读取、优先级如何 → 见 `merge.config`、`qq.settings`。
- `config.json` 里每个 fish 字段的含义 → 见 `fish.settings`。

## 验收

```powershell
# 脚本能加载并打印用法 / 两个目标路径
node packaging/setup.js --help

# 语法检查
node --check packaging/setup.js

# 在发布包根目录（有 config.json）预演，不落盘
node setup.js --dry-run
```

`--help` 输出里的 `fish 段 -> …` 与 `qq 段 -> …` 应分别指向 `~/.dsh-fish/config.json`（或 `$DSH_FISH_HOME`）与 `~/.dsh/qq-bridge-settings.json`（或 `$DSH_HOME`）。
