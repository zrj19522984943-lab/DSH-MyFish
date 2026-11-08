owner: fish.now
anchors: dsh-fish-qq/fish/lib/now.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.now

本文档是 `fish.now` 的唯一事实来源：`fish_now` 工具的输出格式、时区口径与「无参数/只读」约束。

## 事实

- 工具名 `fish_now`；**无参数**（`parameters` 是空对象，`additionalProperties:false`）。
- 输出固定两行：
  ```
  2026-10-30 星期五 17:25（UTC+08:00）
  Unix 时间戳（秒）1793352317
  ```
- 日期 / 星期 / 时分走**本机时区**；括号里写 UTC 偏移（`formatUtcOffset`，东八区 `+08:00`）；第二行是 Unix 秒。
- `formatNow(now)` 是纯函数，可注入时间戳/Date；`readNow(now)` 只调一次 `formatNow`；`registerNow(ctx)` 执行时传 `Date.now()`。
- **绝对只读、零副作用**：不看盘、不联网、不写任何东西；不读配置；时区跟机器走。
- 工具说明只写「能读什么时候」，不写「每天必须看」；不把它变成打卡任务。

## 不负责

- 日记/配额按天怎么算 → 见 `fish.scheduler` / `fish.identity`。
- 系统时间/NTP 校准 → 不在本单元。
- 工具清单 → 见 `fish.tools`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/now.test.mjs
```
重点断言：两行格式、星期映射、UTC 偏移符号、Unix 秒、无参数、纯函数可注入。
