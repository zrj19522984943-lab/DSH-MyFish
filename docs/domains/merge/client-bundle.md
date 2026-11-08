owner: merge.client-bundle
anchors: dsh-fish-qq/client.js; dsh-fish-qq/package.json
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0 / qq@0.1.18

# merge.client-bundle

本文档是 `merge.client-bundle` 的唯一事实来源：二合一包的浏览器半 `client.js`（生成物）如何把两边的设置页合进一个 bundle。

## 事实

- `dsh-fish-qq/client.js` 是**生成文件**，不要手改；源在 `fish/lib/client.js` 与 `qq/client/client.js`，构建时合并。
- 只有一个 `window.__ModuleLoader__.load({ id, factory })`；`id` 必须等于包名 `dsh-fish-qq`（宿主按包名注册客户端 bundle）。
- factory 里拆成 `__fishFactory` / `__qqFactory`，外层合成一个插件形状；两边挂载点不同：
  - fish：`settings.section`（「大肥鱼」整页观测台/设置）；
  - qq：`settings.plugin.item`（0.1.5）或 `settings.plugins.tab`（0.2.0）的「QQ 桥接」卡片。
- 合并包在 factory 里设置 `globalThis.__DSH_QQ_BRIDGE_HOST_ID__='dsh-fish-qq'`，让 qq 半边知道宿主给卡片登记的 entry id 是合并包名（否则 0.2.0 设置页一张卡片都没有）。
- 改完必须**重启 DSH**；`client.js` 不是热更新。`package.json` 的 `dsh.client.platform='web'` 与 `inject=['@deepseek-ai/dsh-client-ui-settings']` 必须保留。

## 不负责

- 生成脚本（`scripts/build-bundle.mjs`，不在包内）→ 见 `ops.release` / 源码工作区。
- fish/qq 卡片字段与保存逻辑 → 见 `fish.identity`（观测台） / `qq.client-card`。
- 宿主半装配 → 见 `merge.lifecycle`。
- 版本号 → 见 `merge.version-matrix`。

## 验收

```powershell
node --check dsh-fish-qq/client.js
```
重点断言：`__ModuleLoader__.load`、id=`dsh-fish-qq`、fish/qq 双 factory、host id、两个设置 slot；改源后重新构建并重启 DSH。
