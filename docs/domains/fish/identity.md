owner: fish.identity
anchors: dsh-fish-qq/fish/lib/identity.js#identityText; dsh-fish-qq/fish/lib/identity.js#attachIdentity; dsh-fish-qq/fish/lib/identity.js#registerIdentity; dsh-fish-qq/fish/lib/selfdoc.js#selfDocPath; dsh-fish-qq/fish/lib/selfdoc.js#renderSelfDoc; dsh-fish-qq/fish/lib/selfdoc.js#writeSelfDoc; dsh-fish-qq/fish/lib/persona.js#personaLine; dsh-fish-qq/fish/lib/persona.js#buildSections
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.identity

本文档是 `fish.identity` 的唯一事实来源：「此刻的她」怎么变成 system prompt 的七个段、怎么落盘成「她的身份.md」，以及 `persona.js` / `selfdoc.js` / `identity.js` 三者的装配关系。人格的产品语义与更细的提示词哲学归 `fish.persona`。

## 事实

### 身份走 system 角色，不走对话

`identity.js` 的通道是 `agent.ctx.systemPrompt.section({ name, order, text })`：渲染成 **system 角色消息**，**不进对话历史**，界面与侧栏看不到。不再写 `home/AGENTS.md`——宿主的工作区指令会把它当**普通 user 消息**注入并留在历史里，等于把设定摊开给用户看。旧文件在 `writeSelfDoc()` 里会被删除（`home/AGENTS.md`）。

`text` 可以是函数，每次组装提示词时才求值，所以文件/配置变了下一轮就生效，不需要重建会话。

### 七个段（名称、顺序、内容来源）

`attachIdentity(agent, root, { workspaceRoot })` 依次注册：

| 段名 | order | 内容来源 |
| --- | --- | --- |
| `fish:handoff` | 900 | `activeHandoffBlockSync(root)`；换会话后的《近期剧情提要》，过期是空串（详见 `fish.handoff`） |
| `fish:identity` | 8500 | `identityText(root)`：读 `<root>/home/她的身份.md`，mtime 缓存 |
| `fish:space` | 8550 | `spaceText(workspaceRoot)`：读 `cyber_house/current_space.json`，小屋 / 武大校园 + POI + 经纬度 |
| `fish:dream` | 8600 | `pendingDream(workspaceRoot)`；有新梦才给 `DREAM_HINT`，展示一次后写 `dreams/.seen` |
| `fish:physical` | 8650 | `physicalText(workspaceRoot)`：`physical_events/*.json`（读走即删，TTL 30 分钟、最多 4 条）+ 手机电量（插着且 3 分钟内更新过） |
| `fish:wake` | 8700 | 模块级 `wakeText`；`setWakeSection()` 在 `sc.prompt()` 前写，`clearWakeSection()` 在回合结束/唤醒失败/卸载时清 |
| `fish:senses` | 8800 | 静态 `SENSES_GUIDE`：只讲基础池工具（check_body / fish_list_dir / sticker / read_house_events / 校园位置），不讲环境数据 |

顺序固定为 handoff < identity < space < dream < physical < wake < senses（测试 `identity.test.mjs` 守着）。`spaceText` 用 `mtimeMs + size` 双签名缓存（同一毫秒连续写两次时避免读到上一份）；`identityText` 用 mtime 缓存，读失败时返回上次缓存文本。

### 挂载与生命周期

`registerIdentity(ctx, { root, herDir, workspaceRoot, log })`：

- 监听 `ctx.on('agent/created')`；只有 `isHerAgent(agent, herDir)` 为真才 `attachIdentity`，不影响用户自己的会话。
- 挂载成功记 `[dsh-fish] 身份段已挂进 system prompt（第 N 次）`；失败只记 `state.why`，**不抛**，插件照常启动。
- 宿主没有 `systemPrompt.section` 时返回 `{ ok: false, why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' }`；此时身份**完全不可见**（因为不再写 AGENTS.md），宁可少一段也不把设定塞回对话。
- 监听注册不上时返回空函数，不崩；`/selfcheck` 的 `identity` 项会报出来。

### 落盘副本：`home/她的身份.md`

- `selfDocPath(root)` = `<root>/home/她的身份.md`；`legacySelfDocPath(root)` = `<root>/home/AGENTS.md`。
- `renderSelfDoc(model, { budget, carry, grants, shown, diary, sleepEveryDays })`：
  1. 先 `personaLine(model, { withBans: true, budget, shown })` 生成人格段；
  2. 若 `grants` 含 `learn-affection`，删掉「## 你还不会的…」节，追加「## 你已经可以了」；
  3. 追加 `## 我手上有什么`：`TOOL_BRIEF`、`RECALL_BRIEF`、`LIST_DIR_BRIEF`、`READ_FILE_BRIEF`、`NOW_BRIEF`；
  4. `diary` 为真时追加 `DIARY_BRIEF`；`sleepEveryDays > 0` 时追加 `SLEEP_BRIEF`；
  5. 追加 `## 被叫醒的时候` 与 `## 这个房间`；
  6. 有 `carry` 时追加（换会话后的临时续接，`activeCarry` 到期自动消失）。
- `writeSelfDoc(root, { log })`：读事件流 + 配置 → `deriveSelf` → `renderSelfDoc` → 与旧文件比较；内容相同不写（避免每轮触发宿主指令重载），不同则 `writeAtomic`；随后尝试删除旧 `AGENTS.md`。返回 `{ ok, changed, file, why? }`，**永不抛**。
- `refreshSelfDoc()` 是 `writeSelfDoc()` 的语义别名（事件/配置/冷落判定变化后调用）。
- `selfDocStatus(root)`：观测台用，返回文件 `exists` / `bytes` / `mtime`。

### `persona.js` 的三样东西

1. **`buildSections(model, opts)`**：核心段永远保留——`## 你是谁`、`## 现在`、`## 不能做的（违反即失败）`、`## 你还不会的（不是不许，是还没到）`、`## 他说的事和你记得的不一样时`，以及有内容时的「没想通的事」「立场清单」；可选段包括她说过的话、两句话对不上、反复想起过的事、更早以前、读到的一句话、被打脸、拒绝过、对自己的说法、想让他改掉你、本次任务。
2. **`assemble(sections, budget)`**：核心段先计入，可选段按原顺序塞到 `budget`（默认 `SELF_DOC_BUDGET = 1800`）为止；核心段**不因字数被裁掉**（`## 不能做的` 属于核心段）。
3. **反人设检查**：`PRESCRIPTION_BANS` 用正则拦住「你句子很短」「你不太会表达」「你应该/要更…」「你是一个…的」「你天生/本来就…」这类把人格写成说明书的句子；`HARD_BANS = promptBans().map(b => b.text)` 是当前进提示词的禁令文本。

当前 `promptBans()` 只有 **2 条**：`no-relational-score`（`section: 'cannot'`，不可把关系数值化）与 `learn-affection`（`section: 'notYet'`，撒娇式表达还不会）。物理层的「不可读自己参数」「不可改自己」`section: null`，刻意不进提示词，由代码保证。`BELIEF_SHOWN = 3`、`BELIEF_FOLDED = 3`、`shownCount()` 夹在 1–8。

### 已知偏差

- **「四条禁令」的说法过时**：`dsh-fish-qq/fish/README.md` 目录节写 `persona.js 她看到的那段提示词（四条禁令在这里）`；代码 `persona.js` 的 `HARD_BANS` 来自 `rules.js` 的 `promptBans()`，当前只有 **2 条**进提示词（契约层 `no-relational-score` + 成长层 `learn-affection`）。另外两条（`no-read-self` / `no-self-modify`）是 `physical` 层，`section: null`，**刻意不写进提示词**，由代码保证（详见 `rules.js` 的 `LAYERS` / `RULES`）。四层规则仍然存在，但不是「四条都进提示词」。
- `fish/README.md` 的 `restrict.js` 条目说它是「只让她看见自己的工具（收窄 inherited 层 + 非她会话的 deny 兜底）」；2026-11-08 起还有 `scope.js` 的 own 层挂载与 `guard`，`restrict` 只是其中一把刀。完整三把刀见 `fish.tools` / `fish.scope`。
- `selfdoc.js` 头部注释写 N2「不出现任何数值」、N3「不出现状态库路径/字段名/JSON」、N4「明确你不能改自己」；代码侧的强制检查是 `PRESCRIPTION_BANS`（拦住把人写成形容词/说明书的句子）和 `promptBans()` 的禁令文本。N2/N3 是生成时的设计约束，不是运行时正则校验；`writeSelfDoc` 不会因为出现了数字就失败。
- `identity.js` 注释说「`text()` 是同步求值，不能 await」；`attachIdentity` 里 `fish:dream` 的回调会同步 `markDreamSeen` 写盘，属于同步副作用，原注释没展开这一点。行为上只在有新梦时写一次。

## 不负责

- 人格提示词的完整产品语义、阶段带宽、禁令的来路 → 见 `fish.persona`。
- `deriveSelf` 如何从事件流派生「此刻的她」、阶段门与瓶颈 → 见 `fish.growth`。
- 《近期剧情提要》的生成、10 秒超时与 30 秒陈旧阈值 → 见 `fish.handoff`。
- 对话原文记忆、`seq_id` → 见 `fish.memory`。
- `memory.docBudget` / `memory.beliefsShown` / `diary.*` 的默认值与存储 → 见 `fish.settings`。
- `fish:physical` 的事件产生端（网关延迟 / 手机电量） → 见 `house.sensor`；本单元只记录读取与注入。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/identity.test.mjs
```

重点断言：七个段都挂上且顺序为 handoff < identity < space < dream < physical < wake < senses；校园/小屋快照动态换前缀；decorate / memory 段已从常驻 system prompt 删掉；handoff 段 8 轮或 3 天后消失；senses 段只讲基础池工具、不含环境数据；dream 段展示一次后为空；physical 段读走即删、过期事件与旧电量不出现；宿主不支持 `systemPrompt.section` 时如实返回 `ok:false`。
