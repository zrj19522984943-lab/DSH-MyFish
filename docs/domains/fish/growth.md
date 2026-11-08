owner: fish.growth
anchors: dsh-fish-qq/fish/lib/derive.js; dsh-fish-qq/fish/lib/capture.js; dsh-fish-qq/fish/lib/stance.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.growth

本文档是 `fish.growth` 的唯一事实来源：四个成长阶段、三道瓶颈、`growth_commit` 唯一写入口、事件如何派生「此刻的她」、以及立场清单的上限。身份渲染归 `fish.identity`。

## 事实

- 阶段名固定：`trust`（信任）→ `autonomy`（自主）→ `competence`（主动）→ `integrate`（整合）；对外名字 `STAGE_NAMES = ['信任','自主','主动','整合']`。
- `stageBounds(growthDays)` 按权重 `[0.27, 0.54, 0.87, 1.0]` 算阶段边界；`growthDays` 夹在 7–180（默认 30）。30 天时约 D1–8 / 9–16 / 17–26 / 27–30。
- 阶段门顺序 `GATE_ORDER = ['trust','autonomy','competence']`：
  - 信任：至少写下一条自己的判断；
  - 自主：真的拒绝过两件事；
  - 主动：两次推翻自己之前的判断；
  - 整合：回顾过去、有意识地发现自己的改变。
- `deriveSelf(events)` 是纯函数：`stage = min(elapsedStage, gateStage)`；没通过门就停在原阶段，`growthDays` 走完后可强制推进（`stageForced`）。`model.stageGate` 给出已过/待过的门。
- **唯一写入口**：`growth_commit` 工具（`registerCapture`）。`type` 只接受 `HER_TYPES`（`utterance` / `revise` / `reunion` / `narration` / `refusal`），另加 `diary` 分支；`revise` 必须带 `refs` 指向旧 `ev_xxx`，`verdict` 是 `confirmed` / `refuted` / `refined`。
- 事件只追加：没有 update/delete/reset；`capture.js` 的 `debrief()` 把读到的网络文本当素材、防注入。
- 立场：`STANCE_MAX = 12`（清单最多 12 条），`STANCE_PROMPT_MAX = 8`（进身份文档最多 8 条）；只有 `gatesDone(model)` 四阶段走完才开始产生。
- 事件流是唯一真相源；`state.json` 是派生快照，可由 `deriveSelf` 重算（见 `fish.memory` / `fish.identity`）。

## 不负责

- 身份文本怎么渲染/落盘 → 见 `fish.identity`。
- 对话原文与 `seq_id` → 见 `fish.memory`。
- 每天什么时候醒、事件/提问配额 → 见 `fish.scheduler`。
- 工具清单与三把刀 → 见 `fish.tools`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test --test-isolation=none
```
重点断言：阶段边界与门、`stage=min(elapsed,gate)`、`growth_commit` 只接受 HER_TYPES、`revise` 必须带 refs、立场 12/8。
