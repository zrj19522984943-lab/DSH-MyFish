owner: fish.scope
anchors: dsh-fish-qq/fish/lib/scope.js#normDir; dsh-fish-qq/fish/lib/scope.js#readHerIdentity; dsh-fish-qq/fish/lib/scope.js#isHerAgent; dsh-fish-qq/fish/lib/scope.js#createToolCapture; dsh-fish-qq/fish/lib/scope.js#mountToolDefinitions; dsh-fish-qq/fish/lib/scope.js#setAgentToolsAllowed; dsh-fish-qq/fish/lib/scope.js#restoreAgentTools; dsh-fish-qq/fish/lib/index.js#registerToolRestrict
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.scope

本文档是 `fish.scope` 的唯一事实来源：fish 工具如何从「插件 ctx 的 global 层」迁到「她那条会话的 own 层」，以及按轮收放、身份判定、热重载补挂的实现。工具名单与三把刀的策略归 `fish.tools`。

## 事实

### 为什么需要会话级隔离

插件 ctx 不在任何 agent 的 scope 里；在插件 ctx 上 `tools.register` 会落进 **global 层**，每个会话都看得见——包括用户写代码的工作区（会看到 `fish_search_history` / `fish_decorate_room` 一整套）。她自己的 `restrict` 只作用于 `cwd === herDir` 的那条会话，挡不住别的会话看见这些定义。

宿主的正确入口是 `agent.ctx.tools.register(def)`：Cordis service 是 traceable 的，经 `agent.ctx.tools` 访问时 `this.ctx` 会重绑到该 agent 的 scope，注册落进它的 **own 层**，只有它自己看得见；own 层不受 `restrict` 的 allow/deny 影响。

### 身份判定

- `normDir(p)`：空值返回 `''`；去掉末尾 `/` / `\`，尽量 `resolve()`；Windows 下转小写（大小写不敏感）。
- `readHerIdentity(root)`：读 `<root>/home.json`，把 `sessionId` 与 `rotatedFrom` 收进 `sessionIds` 集合，另取 `wsId` / `title`。文件不存在、半截 JSON、读不动都返回空集合，**永不抛**。
- `isHerAgent(agent, herDir, root)`：
  1. 从 `agent.id` / `agent.session.id` / `agent.session.header.sessionId` 取 id；若 id 在 `home.json` 的 `sessionIds` 里 → `true`（轮换刚发生时旧会话仍算她）。
  2. 否则比较 `agent.session.header.cwd` / `agent.header.cwd` / `agent.session.cwd` 的 `normDir` 与 `herDir`；相等 → `true`。
  3. `root` 缺省时从 `herDir` 的上一级推；`herDir` 为空或 cwd 为空 → `false`。
- 这个判定同时被 `restrict.js`（挂载/收窄/deny）和 `identity.js`（挂身份段）复用；改判据会影响两边。

### 收集定义：`createToolCapture(baseCtx, sink)`

- `sink` 必须是数组，否则抛 `TypeError`。
- 返回一个 `Proxy`：`ctx.tools` 被替换成 `recorder`，其 `register(definition)` 只把**有非空字符串 `name`** 的定义 `push` 进 `sink`，并返回一个空操作 disposer（定义还没挂，注册函数却会存 disposer）。
- 除 `tools` 外的所有属性原样转发给真 ctx；函数属性 `bind` 回真 ctx（Cordis 的 `get` / `on` / `emit` / `effect` 依赖调用方上下文）。
- 用途：插件启动时把 20 个 fish 工具（合并包里再加 7 个 QQ 工具）收进 `herToolDefs`，**不碰 global 层**。

### 挂载：`mountToolDefinitions(agent, definitions)`

- 要求 `agent.ctx.tools.register` 可用；不可用返回 `{ mounted: [], failed: ['agent.ctx.tools.register 不可用（宿主版本不支持会话级注册）'], control: null }`。
- 按 `definition.name` 建 `Map`，**同名只挂最后一次**（插件热重载 / 重复 apply 不会因 duplicate 整条失败）。
- 逐个 `tools.register(definition)`；成功收进 `active` 与 `disposers`，失败只记 `failed`（单个工具失败不影响其余工具）。
- 返回 `{ mounted, failed, control }`，并把这个 `control` 存进模块级 `WeakMap<agent, control>`。
- `control` 的接口：
  - `names`：全部定义名（不管当前是否挂上）；
  - `active()`：当前真的挂上的名字；
  - `setAllowed(allow)`：只留 `allow` 里点到、且属于本插件的工具；没点到的卸下，点到的重新挂上；返回真正挂上的名字；
  - `restore()`：把全部工具重新挂上；
  - `disposeAll()`：插件卸载时全部摘掉，避免热重载后重名注册失败。
- `setAgentToolsAllowed(agent, allow)` / `restoreAgentTools(agent)` 是 `control` 的模块级入口；QQ 桥接的按轮工具路由通过共享 `herToolDefs.control` 调它们（own 层不能用 `restrict` 做按轮收放）。

### index.js 的调用处

`fish/lib/index.js` 在收集完工具定义后、`bootstrapHome()` **之前**调用：

```js
registerToolRestrict(ctx, {
  root,
  herDir,
  extra: config?.tools?.allow ?? [],
  enabled: config?.tools?.restrict !== false,
  mount: (agent) => mountToolDefinitions(agent, herToolDefs),
  onResult: (r) => { restrictState = r },
})
```

- 必须早于她那条会话创建：`agent/created` 是同步串行监听，晚一步就漏掉第一次。
- `mount` 只对 `isHerAgent()` 为真的 agent 调用；非她会话只走 `denyPluginTools()`。
- 插件热重载时，`registerToolRestrict` 用 `ctx.get('agents').list()` 对已活着的 agent 补跑 `onCreated`。
- 返回的 `off` 被 push 进 `disposers`，插件卸载时注销监听。

### 已知偏差

- `dsh-fish-qq/对接文档.md` §5.1 用「两把刀」描述 restrict + guard；代码实际是 **own 层挂载 + restrict + guard** 三层，另有非她会话的 deny 兜底。第 1 步的 own 层描述与代码一致，只是「两把刀」的命名没有把 own 层算进去。
- §5.1 说 `agent/created` 确认是她那条会话的判据是「`home.json` 的 `sessionId` / `rotatedFrom` 命中，或 cwd = `~/.dsh-fish/home`」；代码还接受 `agent.header.cwd` / `agent.session.cwd` 两个变体，并在 Windows 上做大小写归一化。这是补充，不是冲突。
- `fish/README.md` 第 232 行说 scope.js 是「收集定义 → agent/created 时挂进她自己的 own 层」；代码还提供 `setAllowed` / `restore` / `disposeAll` 与热重载补挂，原描述不完整但方向正确。

## 不负责

- `FISH_TOOLS` / `QQ_BRIDGE_TOOLS` / `HER_TOOLS` 的清单、数量与三把刀策略 → 见 `fish.tools`。
- 身份段的 system prompt 挂载与「她的身份.md」落盘 → 见 `fish.identity`。
- QQ 侧按轮工具路由的意图判断 → 见 `qq.tools`（或 `qq.outbound` 中的相关行为）。
- 宿主 `restrict` / `guard` 的 API 语义 → 宿主文档；本单元只记录 fish 怎么用。
- 工具本身的参数与执行 → 各自单元；本单元不展开。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/scoped.test.mjs
```

重点断言：她的工具只在 own 层、用户工作区看不到、global 漏出时非她会话被 deny、`sessionId` 命中 `home.json` 时即使 cwd 不同也认作她、`createToolCapture` 只收定义不注册、重名只挂最后一次、可按轮收放、热重载补挂。
