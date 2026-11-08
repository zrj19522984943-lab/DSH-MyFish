owner: qq.client-card
anchors: dsh-fish-qq/qq/client/client.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.client-card

本文档是 `qq.client-card` 的唯一事实来源：QQ 桥接的浏览器半设置卡片——挂载点、settings 命名空间、字段分组与保存/撤销覆盖。宿主半设置读取归 `qq.settings`。

## 事实

- 文件 `qq/client/client.js`；由 `package.json` 的 `exports."./client"` 与 `dsh.client` 声明，合并包构建时被打进 `dsh-fish-qq/client.js`。
- 模块 id 必须是宿主包名（合并包 `dsh-fish-qq`，独立安装 `dsh-qq-bridge`）；`__ModuleLoader__.load({ id, factory })` 包装；导出 `name` = 包名。
- 挂载点：兼容 `settings.plugin.item`（0.1.5）与 `settings.plugins.tab`（0.2.0），两个 slot 各注册一次，哪个存在哪个生效。
- 设置 key 必须逐字等于 `qq-bridge`；0.2.0 走本机 `/api/qq-bridge/settings`（GET/POST），0.1.5 走 `settings` 命名空间。
- 卡片按手风琴分组：核心与权限 / QQ 唤醒与投递 / 出站与功能 / 私人时间与主动 / 底层基础设施 / 情报流水线 / 环境传感器；字段与 55 项 `BridgeSettings` 对齐（`qq.settings`）。
- 数据源：`settings.section` 或本机接口；GET 返回 `{values, overridden}`，POST `{set, unset}`；「撤销覆盖」发 `unset`。
- 目标会话是下拉选择（会话标题/项目名），归档会话不列出，当前选中的例外标「已归档」；不在列表里的保留兜底项。
- 没有可写设置服务时如实显示 unavailable，不静默消失；修改 `client/` 后必须重启 `dsh web` 并刷新页面（bundle 不是热更新）。

## 不负责

- 55 项设置的键/默认值/存储 → 见 `qq.settings`。
- 宿主半 `readSettings()` 与设置接口实现 → 见 `qq.settings`。
- 合并包的 client 生成/双设置页打包 → 见 `merge.client-bundle`。
- 设置项的运行时效果（唤醒/出站/主动私聊）→ 见 `qq.wake` / `qq.outbound` / `qq.proactive` / `qq.idle`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-smoke.mjs
```
重点断言：模块 id、双 slot、key=`qq-bridge`、55 字段、手风琴分组、GET/POST 形状、撤销覆盖、归档会话兜底。
