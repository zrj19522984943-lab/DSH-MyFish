# 动态工具路由改动前的全局备份

时间：2026-11-04
项目：`dsh-fish-qq`（工作区 `D:\demo\workspace\dsh-fish-qq`，DSH 里是指向它的 junction）

## 一、备份内容

`backup_before_routing/` 按**项目内的相对路径**保存了改动前的文件：

| 文件 | 为什么备份 |
| --- | --- |
| `qq/index.js` | 动态工具路由、意图字典、按轮 restrict / 回收、常驻用法说明瘦身 |
| `fish/lib/restrict.js` | 底层工具白名单（本次未改，保留原样用于回退） |
| `fish/lib/identity.js` | 删掉 fish:decorate / fish:memory 两个常驻段 |
| `fish/lib/selfdoc.js` | 删掉 work_request / 留话 / B 站 / 评论区的常驻说明 |
| `fish/lib/persona.js` | 同批提示词文件（TOOL_BRIEF 里删掉 bili_watch 两行） |
| `fish/test/identity.test.mjs` | 身份段测试（段数从 7 改为 5） |
| `qq/test-smoke.mjs` | 用法说明测试（扩展工具长说明改为按需注入） |
| `qq/test-filesend.mjs` | 发文件用法测试（改由指令当轮注入） |
| `qq/test-subsend.mjs` | subsend 用法测试（改由指令当轮注入） |
| `qq/test-send-multi.mjs` | 分条用法测试（改由意图路由当轮注入） |

`SHA256SUMS.txt` 是这些备份文件的 SHA-256，可以用 `certutil -hashfile <文件> SHA256` 对照。

## 二、一键回退

双击 `rollback.bat`，或者在命令行运行：

```bat
backups\rollback.bat
```

它会：

1. 把 `backup_before_routing/` 里的文件覆盖回项目对应路径；
2. 删除本次改动新增的 `qq/test-tool-routing.mjs`（清单见 `NEW_FILES.txt`）；
3. 打印「回退成功，请重启 DSH」。

回退后必须重启 DSH，插件才会重新加载旧代码。

## 三、验证记录

- 回退脚本已在临时目录做过完整自测：备份树里的文件哈希全部与备份一致，新增文件被删除。
- 注意：`rollback.bat` 用的是 `xcopy /E /I /Y`，只覆盖备份里存在的文件，不会删除项目里其它文件。
