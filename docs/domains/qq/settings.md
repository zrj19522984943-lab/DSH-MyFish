owner: qq.settings
anchors: dsh-fish-qq/qq/index.js#Config; dsh-fish-qq/qq/index.js#BridgeSettings; dsh-fish-qq/qq/index.js#readSettings; dsh-fish-qq/qq/index.js#readSettingsFile; dsh-fish-qq/qq/index.js#writeSettingsFile; dsh-fish-qq/qq/index.js#knownSettingKeys
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.settings

本文档是 `qq.settings` 的唯一事实来源。它只回答「QQ 桥接有哪些可写设置、默认值是什么、存在哪里、怎么读」；不回答某个设置如何参与唤醒或出站决策。

## 事实

### 两个 schema

`dsh-fish-qq/qq/index.js` 里有**两个**设置 schema，不能混为一谈：

| schema | 键数 | 用途 |
| --- | --- | --- |
| `Config` | **60** | composition / bundle 层默认值；由 `cordis.patch.yml` 的 `qq:` 槽提供。= contract 生成的全部用户设置（55）+ 5 个装配键：`statePath`、`debugTools`、`debugToolsInWorkspace`、`heartbeatTimeoutMs`、`napcatAsset`。 |
| `BridgeSettings` | **55** | 用户可写的设置卡片 schema；= contract 生成的 52 项 + 手写的 3 个 composition-only 键（`targetSessionId` / `workspaceRoot` / `agentPreset`）。`knownSettingKeys()` 取 `BridgeSettings.dict` ∪ contract。 |

两个 schema 的交集是 55 个键。`Config` 独有 5 个：`statePath`、`debugTools`、`debugToolsInWorkspace`、`heartbeatTimeoutMs`、`napcatAsset`；`BridgeSettings` 没有独有的键。

两个 schema 都由 `qq/shared/settings-contract.js` 生成（`buildSchemaFromContract()`）：改类型/默认值/描述只改 contract。`targetSessionId` / `workspaceRoot` / `agentPreset` 标了 `compositionOnly: true`，Schema 与 `readSettings` 循环都跳过它们，仍由 `index.js` 手写（跟鱼屋、读环境变量、透传 resume）。

### 55 项用户设置（`BridgeSettings`）

下表按 `settings-contract` 的声明顺序列出全部 55 项。默认值取自字段的 `default`；常量（`PROACTIVE_DEFAULTS` / `IDLE_TRIGGER_DEFAULTS` / `SUBSEND_DEFAULTS` / `CHECKLOG_NOTIFY_DEFAULTS` / `ENV_SENSOR_DEFAULTS`）展开成实际值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetSessionId` | `''` | 固定目标会话 id；合并包开着 `targetSessionFromFish` 时以 `home.json` 为准（见 `qq.session`） |
| `workspaceRoot` | `''` | 派活 / 看目录 / 读文件 / 发文件的沙箱根；空 = 这些能力如实说没配 |
| `nicknames` | `['244']` | 命中即唤醒的昵称/别名（归一化后子串匹配） |
| `wakeProbability` | `0.05` | 群聊里既没 @ 也没叫名字时的唤醒概率（0–1） |
| `privateWakeProbability` | `1` | 私聊里既没 @ 也没叫名字时的唤醒概率（0–1）；1 = 每条都回 |
| `whitelist` | `[]` | 允许唤醒的私聊 QQ 号；空 = 谁都不能唤醒（fail-closed） |
| `groupWhitelist` | `[]` | 允许唤醒的群号；空 = 任何群都不唤醒 |
| `admins` | `[]` | 管理员 QQ 号；可聊天、派活、用 fileget/filesend/receive，不能下 subsend/whitelist/admin |
| `attachRecentChat` | `true` | 唤醒时是否把「未唤醒期间」的聊天记录附上 |
| `recentChatLimit` | `8` | 未唤醒摘要最多带最近几条；读设置时夹在 0–200 |
| `replyMaxChars` | `1500` | 出站文本字数上限（按下限 100 抬升） |
| `onebotUrl` | `''` | NapCat 正向 WS 地址；空 = 完全不启用传输 |
| `accessTokenEnv` | `''` | access_token 的**环境变量名**（凭据引用），不是 token 本身 |
| `selfId` | `''` | 机器人自己的 QQ 号；空 = 连上后 `get_login_info` 自动取 |
| `replyWithQuote` | `false` | 回复时引用触发的那条消息 |
| `atOnlyInGroup` | `false` | 群里只有被 @ 才处理（比概率更严） |
| `stripMarkdown` | `true` | 出站前去掉 Markdown 标记 |
| `replyMode` | `'marker'` | 出站方式：`marker` / `tool` / `always`（非法值归一化为 `marker`） |
| `delivery` | `'auto'` | 投递方式：`auto` / `followup` / `steer`（非法值归一化为 `auto`） |
| `visionModel` | `''` | 图片描述的模型，`provider/model`；空 = 自动找 |
| `agentPreset` | `''` | resume 目标会话时挂载的 agent preset；空 = 沿用会话 header |
| `napcatInstallDir` | `''` | NapCat 安装目录；空 = `$DSH_HOME/napcat` |
| `napcatVersion` | `''` | 要装的 NapCat 版本 tag；空 = 最新 |
| `downloadProxy` | `''` | 下载 NapCat 的 HTTP 代理；空 = 读环境变量 |
| `onebotPort` | `3001` | 写进 NapCat 配置、并用来连的正向 WS 端口；读设置时夹在 1–65535 |
| `qqNumber` | `''` | 快速登录用的 QQ 号（需先成功登录过一次） |
| `ownerQQ` | `''` | 主人 QQ；空 = 谁都不是主人（fail-closed）；读设置时只留数字 |
| `proactiveEnabled` | `false` | 主动私聊总开关 |
| `proactiveIdleHours` | `4` | 多久没有往来算「空闲」（小时）；读设置时夹在 0–720 |
| `proactiveProbability` | `0.15` | 每次扫描命中主动私聊的概率（0–1） |
| `proactiveDailyLimit` | `3` | 每天最多几条；读设置时夹在 0–50 |
| `proactiveScanIntervalMinutes` | `30` | 扫描间隔（分钟）；读设置时夹在 1–1440 |
| `idleTriggerEnabled` | `false` | 「私人时间」总开关 |
| `idleTriggerScanIntervalMinutes` | `30` | 判定周期（分钟）；读设置时夹在 1–1440 |
| `idleTriggerMinIdleHours` | `2` | 多久没人找她才算空闲（小时）；读设置时夹在 0–720 |
| `idleTriggerDailyMax` | `3` | 每天最多真的注入几段；读设置时夹在 0–50 |
| `idleTriggerWeightSilent` | `80` | 抽签权重：silent（必须占绝对优势） |
| `idleTriggerWeightMessage` | `10` | 抽签权重：message |
| `idleTriggerWeightBrowse` | `5` | 抽签权重：browse |
| `idleTriggerWeightDiary` | `5` | 抽签权重：diary |
| `subsendEnabled` | `true` | 主人 `subsend` 通道开关 |
| `subsendDailyLimit` | `20` | 每天最多几条；读设置时夹在 0–500 |
| `subsendCooldownSeconds` | `20` | 两次发送最短间隔（秒）；读设置时夹在 0–3600 |
| `checklogNotifyMode` | `'off'` | 任务完成通知：`off` / `system` / `agent` |
| `checklogNotifyOnSuccess` | `false` | 任务成功也通知；默认只在失败/超时/异常时说 |
| `checklogNotifyDailyLimit` | `5` | 每天最多通知几条；0 = 不发 |
| `checklogNotifyTarget` | `'owner'` | 通知发给谁：`owner` / `last` |
| `rssFeeds` | `''` | 预留：资讯流水线 RSS 源；逻辑未接 |
| `pipelineWorkerApi` | `''` | 预留：流水线 worker API 地址 |
| `pipelineWorkerKey` | `''` | 预留：流水线 worker 校验密钥 |
| `modelPool` | `[]` | 模型池；schema 默认空数组，读设置时归一化成固定 3 个槽位 |
| `envSensorEnabled` | `false` | 环境传感器总开关；只写 `sensors/status.md`，不注入提示词 |
| `envWeatherCity` | `''` | 城市名或「纬度,经度」；空 = 只看本机 |
| `envSensorTime` | `'*/15 * * * *'` | 五段式 Cron 或 `HH:MM` |
| `envMemoryThreshold` | `80` | 内存占用报警阈值（0–100） |

### 读取与优先级

`readSettings()` 的实际优先级：

1. **0.1.5 老宿主**：`ctx.settings.get('qq-bridge')`（settings 命名空间）优先；取不到回落到 `config`。
2. **0.2.x 宿主**：`$DSH_HOME/qq-bridge-settings.json`（或 `statePath` 同目录）里的 `values` 优先；没有该文件 / 文件坏了都当「没有覆盖」，回落到 `config`。
3. 每个键最后再回落到 contract 字段的 `default`（`Config` 由 contract 生成）；`readSettings()` 用字段自带的 `normalize` 逐项收敛（概率 0–1、端口 1–65535、`ownerQQ` 只留数字等）。

读取实现：

- `readSettingsFile()` 按文件 `mtimeMs` 缓存；文件不存在或 JSON 坏掉时返回 `{}`，不抛错。
- `writeSettingsFile()` 先写 `<path>.tmp` 再 `rename`，文件结构固定为 `{ version: 1, values: {...} }`；写完清空缓存，下一条消息立即生效。
- `heartbeatTimeoutMs` 只从 `config` 读（不在 `BridgeSettings` 里，用户设置文件无法覆盖它）。

`targetSessionId` 是唯一有「合并包专有」覆盖逻辑的键：`targetSessionFromFish: true` 时每次读设置都同步读一次 `~/.dsh-fish/home.json`，鱼的最新 `sessionId` 优先；详见 `qq.session`。

### 设置接口

`GET/POST /api/qq-bridge/settings`（0.2.x 宿主）：

- `GET` 返回 `{ ok, values（生效值）, overridden（用户层显式设过的键） }`。
- `POST` 接受 `{ set?: {...}, unset?: [...] }`；先按 `BridgeSettings` 校验，再只写 `knownSettingKeys()` 里的键，最后跑传输重连/提示词重挂。
- 只接受本机请求：对端必须是回环地址；有 `Origin`/`Referer` 时主机必须是 `127.0.0.1` / `localhost` / `::1`；带请求体的 POST 必须声明 `application/json`。否则 403。
- 非法值（例如 `wakeProbability: "abc"`）在 schema 校验处返回 400，不落盘。

### 已知偏差

- **「55 项」的口径**：`dsh-fish-qq/对接文档.md` §4.4 标题写「qq 设置（55 项）」，表里也正好 55 行；代码里 `BridgeSettings` 是 55 个键，`Config` 是 60 个键。差异 = `Config` 独有的 5 个装配键（`statePath` / `debugTools` / `debugToolsInWorkspace` / `heartbeatTimeoutMs` / `napcatAsset`）不在用户设置表里；`BridgeSettings` 没有独有的键（6 个从前的独有键现在也由 contract 生成进 `Config`）。**55 行表对应的是 `BridgeSettings` / `settings-contract`，不是 `Config`。**
- **昵称默认值**：`BridgeSettings` 是 `['244']`，但 `dsh-fish-qq/cordis.patch.yml` 的 qq 槽写的是 `['244', '小助手']`。合并包安装后的实际生效默认值是两项（patch 是 composition base，见 `merge.patch`）。
- **`modelPool` 的「3 槽」**：schema 默认是 `[]`；`readSettings()` 调 `normalizeModelPool()` 后固定成 3 个槽（空的也占位）。文档写「3 个固定槽位」描述的是归一化后的形状，不是 schema 默认值。
- **`napcatAsset`**：`Config` 里有 `napcatAsset`（默认 `DEFAULT_ASSET`），55 项用户设置和设置卡片都没有这一项；它是 composition/安装器参数。
- **设置命名空间**：`对接文档.md` §4.4 的描述混合了 0.1.5 的 `settings` 命名空间与 0.2.x 的自有文件/接口。代码按宿主能力分支：有 `settings.register` 走老模型，否则走 `$DSH_HOME/qq-bridge-settings.json` + 本机 HTTP 接口。两条路都以 `readSettings()` 为唯一读入口。

## 不负责

- 这些设置如何参与唤醒判断 → 见 `qq.wake`。
- `targetSessionId` 如何跟随鱼的屋子、`home.json` 的读取 → 见 `qq.session`。
- `ownerQQ` / `admins` 的产品语义与来源标记 → 见 `qq.owner`。
- `replyMode` 在出站时的实际效果 → 见 `qq.outbound`。
- patch 文件里的 composition 默认值与合并包专有开关 → 见 `merge.patch`。
- 白名单指令 / help / receive / list 的文本解析 → 见 `qq.safety`。

## 验收

```powershell
# 1) 文档锚点与三行头
node scripts/docs-lint.mjs

# 2) 设置卡片字段 / 策略分支回归
cd dsh-fish-qq/qq
node test-smoke.mjs
```

另外核对键数（应输出 `Config 60 / contract 55`）：

```powershell
node --input-type=module -e "const m=await import('./dsh-fish-qq/qq/index.js');const c=await import('./dsh-fish-qq/qq/shared/settings-contract.js');console.log('Config',Object.keys(m.Config.dict).length,'/ contract',c.SETTINGS_CONTRACT.length)"
```
