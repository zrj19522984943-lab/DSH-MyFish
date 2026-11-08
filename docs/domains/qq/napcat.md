owner: qq.napcat
anchors: dsh-fish-qq/qq/napcat.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.napcat

本文档是 `qq.napcat` 的唯一事实来源：NapCat 自助托管的下载、sha256 校验、解包、配置与启停。OneBot 传输归 `qq.onebot`。

## 事实

- 仓库 `NapNeko/NapCatQQ`；默认资产 `NapCat.Shell.Windows.OneKey.zip`；`MIN_QQ_BUILD = 40768`。
- 下载：GitHub Release API 取资产，按 `asset.digest` 的 sha256 校验；不匹配删除下载文件并报错；没有摘要时只警告（记录实际摘要）。HTTP 超时默认 900000ms；代理取 `downloadProxy` / 环境变量。
- 解包：`extractZip()` 纯 Node 实现，拒绝 zip-slip（路径必须落在目标目录内）；`crc32` 校验。
- 配置：`oneBotConfig({port,token,host,name})` + `writeOneBotConfig()` 写 `config/onebot11.json`，正向 WS 端口与 token；默认端口 3001。
- 启停：优先 `launcher-win10.bat` / `launcher.bat`（可能 UAC），没有脚本时直接调 `NapCatWinBootMain.exe` + `NapCatWinBootHook.dll`；由宿主 subprocess 服务托管，插件卸载 / DSH 退出时一并结束。
- **加载时绝不下载或执行任何东西**；所有动作由 `qq_bridge_napcat` 显式触发：`status` / `download` / `configure` / `launch` / `stop`。
- 安装目录默认 `$DSH_HOME/napcat`；WebUI 地址从 `<安装目录>/config/webui.json` 读 host/port/token。

## 不负责

- OneBot WS 连接/重连/入站映射 → 见 `qq.onebot`。
- NapCat 工具的参数与权限 → 见 `qq.tools` / `qq.safety`。
- 设置项 `napcatInstallDir` / `napcatVersion` / `downloadProxy` / `onebotPort` 的默认值 → 见 `qq.settings`。
- 账户风控与 QQ 首次登录 → 用户手动处理，不在本单元。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-napcat.mjs
```
重点断言：资产选择、sha256 校验失败删除、zip-slip 拒绝、配置写入、启停动作显式触发、加载时不下载。
