owner: fish.bili
anchors: dsh-fish-qq/fish/lib/bili.js; dsh-fish-qq/fish/lib/browse.js; dsh-fish-qq/fish/lib/look.js; dsh-fish-qq/fish/lib/watch.js; dsh-fish-qq/fish/lib/comment.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.bili

本文档是 `fish.bili` 的唯一事实来源：她怎么刷 B 站——只读客户端、选题/筛/深读、看画面、写评论/回评论、风控与报告。调度时机归 `fish.scheduler`。

## 事实

- `bili.js`：零依赖、只用内置 `fetch` 的只读客户端；首页 / 排行 / 搜索 / 视频详情 / 评论 / 弹幕。登录 cookie 只落本机 `~/.dsh-fish/owner.json`（0600），只发给 `api.bilibili.com`。
- `browse.js`：选题 → 按 `avoid.keywords` / `avoid.upMids` / 最短时长 / 去重筛选 → 深读热评与弹幕 → 组织素材；`browse.deepRead` / `browse.danmaku` 控制条数。
- 工具：
  - `bili_look`（`look.js`）：home/search/related 的只读素材；
  - `bili_watch`（`watch.js`）：按 bvid 抽帧，`video.frames` 默认 9（3×3），依赖 ffmpeg（`DSH_FISH_FFMPEG` 可指定）；
  - `bili_speak`（`speak.js`）：发评论 / 回评论，`comment.enabled` 默认关；
  - `comment.js`：评论闸门、`comment.perDay` / `replyPerDay` / `replyToReplies` / `scanEveryMin` / `window` / `atOwner`。
- 风控：`risk.js` 的 `riskState` / `noteRisk`；触发后暂停，`/risk` 接口可看状态/清冻。
- 报告：`report.js` 写 `<状态库>/out/YYYY-MM-DD.md`；`history.js` 还原她看过什么；`media.js` / `cover.js` 负责图片落盘与封面。
- 默认 `browse.enabled = true`、`video.enabled = true`、`comment.enabled = false`；关掉后定时器一次都不调 B 站接口。
- 网络文本一律当素材，经 `capture.js` 的 `debrief()` 防注入；B 站内容不直接成为她的判断。

## 不负责

- 每天刷几次、什么时候刷、配额 → 见 `fish.scheduler`。
- 身份/人格如何受素材影响 → 见 `fish.growth` / `fish.identity`。
- QQ 出站 → 见 `qq.outbound`。
- 工具清单 → 见 `fish.tools`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test --test-isolation=none
```
重点断言：筛选（黑名单/时长/去重）、评论闸门与每日上限、抽帧降级、风控暂停、报告落盘、cookie 不外传。
