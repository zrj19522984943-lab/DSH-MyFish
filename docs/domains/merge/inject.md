owner: merge.inject
anchors: dsh-fish-qq/index.js; dsh-fish-qq/package.json
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0 / qq@0.1.18

# merge.inject

本文档是 `merge.inject` 的唯一事实来源：二合一包向宿主声明的服务依赖（硬依赖 + 可选降级）。

## 事实

- `inject` 是 fish 与 qq 两边 `inject` 的**并集**（`[...new Set([...fishInject, ...qqInject])]`）：
  - fish：`sessionController`、`tools`、`webServer`、`connection`；
  - qq：`agents`、`tools`、`settings`；
  - 合并：`sessionController`、`tools`、`webServer`、`connection`、`agents`、`settings`。
- 硬依赖：缺任一服务宿主不会调 `apply`（整包不启动，不半残）。
- 可选服务（`ctx.get` 探测，缺了降级）：
  - `workspaceRegistry`：找/建派活工作区；缺了 `work_request` 只能派到已存在工作区；
  - `credentials`：解析 `accessTokenEnv`；缺了退回 `process.env`；
  - `attachments`：`image_look` 递图；缺了返回原因；
  - `agentPresets`：resume 时挂 preset；
  - `agentDefaultModel`：resume 没记录模型时取部署默认。
- `package.json` 的 `peerDependencies` 是 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`；`dependencies` 为零，运行时靠宿主解析。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` 声明 web 平台与 `@deepseek-ai/dsh-client-ui-settings`。

## 不负责

- 生命周期/启动顺序 → 见 `merge.lifecycle`。
- patch 槽位默认值 → 见 `merge.patch`。
- 各服务的具体用法 → 见 fish/qq 对应单元。
- 版本号 → 见 `merge.version-matrix`。

## 验收

```powershell
node -e "import('./dsh-fish-qq/index.js').then(m=>console.log(m.inject))"
```
应输出 6 个服务名；缺一个宿主不启动。可选服务缺失时只降级，不崩。
