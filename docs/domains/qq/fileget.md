owner: qq.fileget
anchors: dsh-fish-qq/qq/index.js#parseFileCommand; dsh-fish-qq/qq/index.js#resolveWorkspaceFile; dsh-fish-qq/qq/index.js#renderFileInstruction; dsh-fish-qq/qq/index.js#FILE_MAX_BYTES
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.fileget

本文档是 `qq.fileget` 的唯一事实来源：`fileget <相对路径>` / `filesend <QQ号> <相对路径>` 的解析、权限、工作区沙箱、50MB 上限与出站通道。收文件（`receive`）归 `qq.receive`。

## 事实

### 指令正则

- `FILEGET_PREFIX = 'fileget'`、`FILESEND_PREFIX = 'filesend'`。
- `parseFileCommand(text)` 对 `trim()` 后的整条消息：
  - `filesend <5–12位QQ> <路径>` → `{kind:'filesend', targetQQ, path}`（路径取其余全部字符，可含空格）；
  - `fileget <路径>` → `{kind:'fileget', path}`；
  - 路径 trim 后为空 → `null`；消息中间提到前缀不算；大小写不敏感。

### 权限档

- **主人或管理员**：`decide()` 用 `canUseFileCommand` 放行；`file*` 是必唤醒（排在 `atOnlyInGroup` 之前）。
- 管理员下 `fileget` 时，注入说明会要求改用 `qq_bridge_filesend` 发给自己（`fileget` 工具目标固定是 ownerQQ）；主人下 `fileget` 目标就是主人。
- 工具层还有身份闸门：非主人/管理员的轮次发文件会被拒（`not-owner`），一个文件都不发。

### 是否唤醒模型

**是。** `file*` 返回 `{action:'wake', reason:'owner-file'|'admin-file'}`；`renderFileInstruction()` 把路径/目标附给模型，模型调 `qq_bridge_fileget` / `qq_bridge_filesend`。

### 是否进缓冲

**否。** `file*` 是 `wake`，本身不 `state.buffer.push()`；此前的未唤醒缓冲会作为摘要附上。

### outbox 的 via 值

- `fileget` 成功：`via:'fileget'`；`filesend` 成功：`via:'filesend'`。
- 被拒：`dropped` 台账也按 `fileget` / `filesend` 记录（not-owner 例外为 `tool`）。
- 独立出站通道：直调 `upload_private_file`，不经 `replyMode` / `outboundGate`；NapCat 不吃本地路径时退 `base64://` 并记住。

### 每日上限 / 冷却

- **无每日上限、无冷却**：文件不是「话」，没有刷屏循环风险；身份闸门保证只有主人/管理员能发起。
- 硬边界：
  - `FILE_MAX_BYTES = 50 * 1024 * 1024`（50MB），超过拒绝；
  - 路径沙箱：`resolveWorkspaceFile(root, relPath)` 做 `resolve` 归一 → 必须位于工作区根内 → `realpathSync.native` 再判（解析 junction）→ `stat` 必须是普通文件；
  - 失败返回 `no-root` / `outside` / `not-found` / `not-a-file` / `too-big` / `unreadable` + 中文原因，不抛。

### 已知偏差

- **T3 占位**：T3 的指令表先链到 `qq.fileget` 占位；T4 正式建 L1，指令表链接现在可解析。
- **工具数量**：`QQ_BRIDGE_TOOLS` 里是 `qq_bridge_fileget` + `qq_bridge_filesend` 两个；`qq.fileget` 是**指令族/通道**单元，不是单个工具。`对接文档` §5.3 的 13 工具表把它们分别列两行，和这里的「一个单元」不矛盾。
- **`via` 与工具名**：`fileget` 工具固定发主人；管理员要文件必须用 `filesend` 指定自己的号，所以管理员的 `via` 是 `filesend`，不是 `fileget`。

## 不负责

- `receive` 收件箱/收文件命名 → 见 `qq.receive`。
- `subsend` 文本通道 → 见 `qq.subsend`。
- `replyMode` / `outboundGate` → 见 `qq.outbound`。
- 文件大小格式化/台账上限 → 见 `qq.state-file` / `qq.outbound`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-filesend.mjs
```
重点断言：两种正则、5–12 位目标、路径可含空格、主人/管理员权限、工作区越界/不存在/目录/50MB 拒绝、`via=fileget/filesend`、base64 回退。
