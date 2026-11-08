owner: merge.patch
anchors: dsh-fish-qq/cordis.patch.yml
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# merge.patch

本文档是 `merge.patch` 的唯一事实来源：`dsh-fish-qq/cordis.patch.yml` 这一份 bundle patch 的形状、两个 config 槽、以及 patch 里真正写死的默认值。配置的读取优先级归 `merge.config`，55 项设置默认值归 `qq.settings`。

## 事实

### 文件形状

`dsh-fish-qq/cordis.patch.yml` 只有一个顶层 `insert`：

```yaml
- insert:
    - id: dsh-fish-qq
      name: dsh-fish-qq
      config:
        fish: {...}
        qq: {...}
```

- `id` 与 `name` 都是 `dsh-fish-qq`，与包名一致。
- `config` 固定分 `fish:` 与 `qq:` 两槽，分别原样传给 fish 的 `apply()` 与 qq 的 `apply()`；两边互不串味。
- 这是 DSH bundle 的 composition 入口：装包时由宿主读入，改完 patch 必须**重启 DSH** 才生效。

### `fish:` 槽

只写两个键：

| 键 | 值 | 含义 |
| --- | --- | --- |
| `root` | `''` | 状态库根；空 = `$DSH_FISH_HOME` 或 `~/.dsh-fish` |
| `seed` | `''` | 首次播种那句话；空 = 内置那句 |

### `qq:` 槽

patch 只列出一部分 qq 键，**没列出的键走 `Config` / `BridgeSettings` 的 schema 默认值**（见 `qq.settings`）。patch 里实际写死的值：

- **合并包专有**：`targetSessionFromFish: true`。目标会话留空时读 `~/.dsh-fish/home.json` 的 `sessionId`；独立安装 `dsh-qq-bridge` 时没有这个键，行为不变（见 `qq.session`）。
- **目标 / 状态 / 工作区**：`targetSessionId: ''`、`statePath: ''`、`workspaceRoot: ''`。
- **调试工具**：`debugTools: true`；`debugToolsInWorkspace: false`（合并包里 QQ 管理/调试工具默认不注册到用户工作区，排障时才打开）。
- **传输**：`onebotUrl: ''`（空 = 不启用传输）、`accessTokenEnv: ''`、`selfId: ''`、`replyWithQuote: false`、`atOnlyInGroup: false`、`stripMarkdown: true`、`heartbeatTimeoutMs: 90000`、`onebotPort: 3001`。
- **NapCat**：`napcatInstallDir: ''`、`napcatVersion: ''`、`downloadProxy: ''`、`qqNumber: ''`。
- **策略默认值**：`nicknames: ['244', '小助手']`、`wakeProbability: 0.05`、`whitelist: []`、`groupWhitelist: []`、`ownerQQ: ''`、`admins: []`。
- **主动 / subsend / 通知**：`proactiveEnabled: false`、`proactiveIdleHours: 4`、`proactiveProbability: 0.15`、`proactiveDailyLimit: 3`、`proactiveScanIntervalMinutes: 30`；`subsendEnabled: true`、`subsendDailyLimit: 20`、`subsendCooldownSeconds: 20`；`checklogNotifyMode: 'off'`、`checklogNotifyOnSuccess: false`、`checklogNotifyDailyLimit: 5`、`checklogNotifyTarget: 'owner'`。

patch **没有**列出的 qq 键（因此走 schema 默认值）包括：`privateWakeProbability`、`delivery`、`attachRecentChat`、`recentChatLimit`、`replyMaxChars`、`visionModel`、`modelPool`、`rssFeeds`、`pipelineWorkerApi`、`pipelineWorkerKey`、全部 `idleTrigger*`、全部 `envSensor*` / `envWeatherCity` / `envMemoryThreshold`。

### 与用户设置的关系

- patch 里的值是**初始默认值**，不是运行时唯一来源。用户改过之后，值分别落到：
  - fish：`~/.dsh-fish/config.json`（或 `$DSH_FISH_HOME/config.json`）；
  - qq：`$DSH_HOME/qq-bridge-settings.json`（0.2.x）或 `settings` 命名空间（0.1.5）。
- 这些用户层**不会**被 patch 覆盖；要恢复默认，得把 patch 里对应整块重述一遍（文件头注释的原话）。
- 因此「合并包安装后的实际默认昵称」是 `['244', '小助手']`，而 `qq.settings` 里 `BridgeSettings` 的 schema 默认是 `['244']`；两者不矛盾，层次不同。

### 已知偏差

- `dsh-fish-qq/对接文档.md` §2.3 写「只有一个 insert、id/name 都是 dsh-fish-qq、config 分两槽、值是初始默认值」，与代码一致；但它**没有提** `targetSessionFromFish` 这个合并包专有开关，也没有提 `nicknames` 在 patch 里是两项。§4.2 补了 `targetSessionFromFish`，两节要合起来看。
- patch 文件头注释说用户改过的值落在 `$DSH_HOME/qq-bridge-settings.json`；这只对 0.2.x 成立。0.1.5 实际落在宿主 `settings` 命名空间（`settings.yaml`），代码按 `hasLegacySettings()` 分支读取。
- `config` 是 composition base，不是「全部 55 项的完整快照」；patch 的 qq 槽只列了 **37 个键**，其余靠 schema 默认。`对接文档.md` §4.2 的表格也只列了部分槽位，不要把它当成完整默认值表。
- patch 里 `debugTools: true` 与 `debugToolsInWorkspace: false` 是两个不同开关：前者决定是否注册调试工具，后者决定这些工具是否也出现在**用户工作区**。`对接文档.md` §5.1 有解释，但 §2.3 没提。

## 不负责

- 四层配置优先级、`readSettings()` 如何合并用户层与 patch → 见 `merge.config`。
- 55 项设置的键、默认值、存储与 clamp → 见 `qq.settings`。
- `targetSessionFromFish` 的读取逻辑与 `home.json` 优先级 → 见 `qq.session`。
- patch 如何被宿主加载、`apply()` 如何装配两个子插件 → 见 `merge.lifecycle`。
- 安装方式与 profile 登记 → 见 `merge.install`。

## 验收

```powershell
# 1) 文档侧
node scripts/docs-lint.mjs

# 2) patch 关键行仍在（无 YAML 依赖）
node -e "const s=require('fs').readFileSync('dsh-fish-qq/cordis.patch.yml','utf8');for(const k of ['- insert:','id: dsh-fish-qq','name: dsh-fish-qq','fish:','qq:','targetSessionFromFish: true','debugToolsInWorkspace: false'])if(!s.includes(k))throw new Error('missing: '+k);console.log('patch ok')"
```

改完 patch 后重启 DSH；`dsh web` 的客户端 bundle 不会热更新。
