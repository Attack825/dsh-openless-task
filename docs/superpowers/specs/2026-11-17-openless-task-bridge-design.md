# OpenLess → DSH 语音任务桥（dsh-openless-task）设计方案

- 日期：2026-11-17
- 状态：待用户批准（已过一轮构建者审阅）
- 方案：A（OpenLess 当触发器 + 独立小确认窗）

## 1. 意图与「为什么」

用户主要用 OpenLess 说话（全局热键右 Ctrl，跨应用可用），希望说完的话能直接变成 DSH 固定会话里的一项任务：DSH 先识别出要做什么，弹一个小窗让用户确认，点「执行」才在后台动手；全程不打开 DSH 控制台。

技术上要绕开两件事：DSH 插件没有系统级全局热键，也造不出原生窗口。所以本设计不让 DSH 抢热键、不抢焦点，只做「文件变了 → 拆任务 → 小窗确认 → 后台执行」。

## 2. 目标 / 非目标

**目标（v1）**
1. 监听 OpenLess 的 `history.json`，出现新的、有正文的语音转写时自动接手。
2. 把这段语音投递到用户预先绑定的那一个 DSH 会话。
3. DSH 在该会话中拆出任务清单，调用插件工具弹出小确认窗。
4. 用户点「执行」→ DSH 才允许动手；点「忽略」→ 停止。**这是闸门，不是提示**：确认前 DSH 只能读、不能改。
5. 正文为空 / 转写失败的历史条目直接跳过，不打扰。
6. 用户不打开 DSH 控制台也能完成「说 → 确认 → 执行」。

**非目标（v1 不做）**
- 系统级热键（不需要：OpenLess 的热键就是全局热键）。
- DSH 窗口内的界面改动、新的 Slot、页面内卡片。
- 执行结果的弹窗展示（v1 需要看结果时打开 DSH；v2 再做「完成/失败」弹窗）。
- 多会话路由、多任务并行、语音内容编辑后再执行。
- macOS / Linux 适配（仅 Windows 验证）。
- 修复 OpenLess 自身的 ASR 故障（见 §3.1，单独处理）。

## 3. 约束与已知风险

1. **空转写是目前真实故障（不在本项目内修复）**：OpenLess 日志显示 `asr_chars=0`、`polish input must not be empty`，13:10 之后没有成功转写。插件只能跳过空条目。本项目用「手工追加 history 条目」的方式验收；真机验收依赖 ASR 先修好，作为前置条件记录，不作为交付里程碑。
2. **OpenLess 一定会把文字插入当前焦点窗口**（失败才退回剪贴板）。若焦点在别的编辑器，会污染目标应用。v1 的缓解：说话时焦点放在非可编辑区域（如桌面 / 网页空白处）。插件不解决这件事。
3. **插件没有全局热键、也没有 Electron 窗口能力**：Host 插件运行在 `dsh-desktop-host` 子进程（`ELECTRON_RUN_AS_NODE=1`）。确认窗由插件自己起一个本地页面，再用 Edge/Chrome 的 `--app` 打开。
4. **固定会话可能未活跃**：`sessionController.prompt()` 会自动 resume 冷会话（"Admit one prompt after explicitly resuming its Session"），不依赖 Agent 在内存里。
5. **工具会阻塞当前回合**：确认工具最长等 5 分钟；期间新语音以 `mode: 'queue'` 排队。
6. **闸门靠工具守卫实现**：`ctx.tools.guard()` 同步拒绝，作用域为绑定的会话 + 有未决语音任务的时段；旗标在确认返回或超时后清除，不会永久卡住会话。
7. **失败对用户不可见是风险**：兜底是错误小窗；没有浏览器时只能写日志（见 §6）。

## 4. 架构

```
OpenLess（右 Ctrl，全局）
   │ 说话 → ASR → 润色 → 写 history.json → 插入焦点窗口
   ▼
Host 插件 dsh-openless-task（DSH 子进程内）
   ├─ 轮询/监听文件，过滤空与失败条目
   ├─ sessionController.prompt() 投递到固定会话（并挂起「待确认」旗标）
   ├─ tools.guard() 在旗标期间拒绝动手类工具
   └─ 本地回环 HTTP 服务（127.0.0.1:随机端口 + 一次性 token）
   ▼
DSH 固定会话（后台，可不在前台）
   │  模型：读材料 → 拆任务 → 调用工具 openless_task_confirm
   ▼
openless_task_confirm ──► Edge/Chrome --app 小窗
   │                        显示：语音原文 + 任务清单 + [执行] [忽略]
用户点击 ──► POST /answer ──► 工具返回 choice ──► 旗标清除
   ▼
execute：模型继续执行（守卫放行）
ignore ：模型停止并说明未执行
```

## 5. 组件与实现要点

### 5.1 包结构（Host-only bundle）

```
dsh-openless-task/
  package.json          name: dsh-openless-task, type: module, dsh.bundle.patch
  cordis.patch.yml      insert 一行插件
  index.js              apply(ctx, config) + export const Config
  lib/watcher.js        history.json 轮询/去重/过滤
  lib/gate.js           待确认旗标 + tools.guard 拒绝清单
  lib/popup.js          本地 HTTP 服务 + 启动浏览器小窗 + 等待应答 + 心跳
  lib/page.js           确认页 HTML（内联 CSS/JS）
  locale/en.json, zh.json
  icon.svg
  docs/DETAIL.md
```

- `export const inject = ['tools', 'sessionController']`；`configEditor`、`webServer` 用 `ctx.get()` 按需取。
- `export const Config = z.object({ ... })`（`@deepseek-ai/schemastery`）。
- 所有注册用 `ctx.effect()` / `ctx.on()` 返回清理函数。
- 工具用 `defineTool`（`@deepseek-ai/dsh-tools`），`ctx.tools.register(defineTool(...))`。

### 5.2 Config

| 字段 | 类型 / 默认 | 说明 |
|---|---|---|
| `enabled` | boolean, `true`, volatile | 总开关，运行中可改 |
| `historyPath` | string, `%APPDATA%\OpenLess\history.json` | 计算得到，可改 |
| `pollMs` | number, `1000`（500–10000） | 轮询周期；`fs.watch` 作为补充 |
| `sessionId` | string, `''` | 固定会话；用绑定工具写入 |
| `confirmTimeoutMs` | number, `300000`（60000–1800000） | 小窗等待上限 |
| `pendingTtlMs` | number, `180000`（30000–600000） | 「待确认」旗标最长挂起时间 |
| `idleWaitMs` | number, `120000`（0–600000） | 会话正忙时最多等多久再投递；0 = 直接投递且不挂旗标 |
| `browserPath` | string, `''` | 空 = 自动找 Edge/Chrome |
| `actingTools` | string[]（默认见 §5.9） | 确认前被守卫拒绝的工具名 |
| `maxPromptChars` | number, `4000` | 超长转写截断并标注 |

### 5.3 监听与过滤（lib/watcher.js）

- 启动时读一次 `history.json`，把最新条目的 `id` 记为基线，**不回放历史**。
- `fs.watch` + debounce 300ms，同时每 `pollMs` 轮询 mtime/size 兜底（OpenLess 可能原子替换文件）。
- 解析失败（半写入）→ 100ms 后重试一次，再失败跳过并记日志。
- 只接受同时满足的条目：
  - `id` 是未见过的字符串；
  - `finalText.trim().length > 0`；
  - `errorCode` 为空；
  - `insertStatus !== 'failed'`；
  - `source === 'voice'`。
- 去重：内存 `Set<id>` 保留最近 200 条。

### 5.4 投递到固定会话

- 未绑定 `sessionId`：不投递，弹一次「未绑定会话」错误小窗（浏览器可用时），然后静默。
- 投递前先等会话空闲（`sessionController.list()` 的 `running`），再挂旗标（§5.9）；一直忙到 `idleWaitMs`（默认 120000）就照投但不挂旗标——旗标只能属于看到语音原文的那一个回合，否则会误伤用户上一轮的 `run_code`/`pwsh`，模型反复重试而确认卡片永远不会被调用（2026-11-17 实测）。投递失败则撤销旗标并弹错误小窗。
- 调用：

```js
await ctx.sessionController.prompt({
  requestId: crypto.randomUUID(),
  sessionId: config.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: composed }],
  clientTimeZone: 'Asia/Shanghai',
})
```

- `composed`（中文）：

```
【OpenLess 语音】以下是我刚说的一段话（语音转写，可能有同音错字）：

<finalText>

处理要求：先判断这段话里有哪些要执行的任务，用简短列表列出，然后调用 openless_task_confirm 工具把任务清单交给我确认。
如果这段话里没有可执行的任务，就只在会话里回答，不要调用 openless_task_confirm，也不要弹窗。
在我点「执行」之前不要动手（确认前，改动类工具会被拒绝）。
我点「执行」后再开始；点「忽略」就停下并说明未执行。
```

### 5.5 确认工具 `openless_task_confirm`

参数（JSON Schema）：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "summary": { "type": "string", "required": true, "description": "一句话说明准备做什么；若是提问，这里放答案" },
    "tasks": { "type": "array", "items": { "type": "string" }, "description": "要做的事，逐条；没有可执行任务时留空" },
    "transcript": { "type": "string", "description": "对应语音原文，留空则由插件取最近一条" }
  }
}
```

输出：`{ "choice": "execute" | "ignore" | "timeout", "popup": "shown" | "unavailable" }`。

`execute(args, exec)`：
1. 生成一次性 token，确保本地服务已启动；
2. 启动浏览器小窗，等待应答 / 超时 / 窗口消失；
3. 返回 choice，并**清除旗标**（无论结果）；
4. `exec.agent.session.id` 只用于日志与守卫归属。

### 5.6 小窗与本地服务（lib/popup.js）

- `node:http` 只绑 `127.0.0.1`，端口 `0`（系统分配），路由 `/`（页面）与 `/answer`（POST）。
- 每个请求校验 `?t=<token>`；token 为 `crypto.randomBytes(16).toString('hex')`，单次有效。
- 页面：原生 HTML + 内联 CSS（无外部资源），中文；显示「语音原文（可折叠）」+ `summary` + 任务列表 + 两个按钮「执行 / 忽略」。
- 关闭语义：点 X 视为「忽略」。
  - 页面每 2s 发一次 `fetch('/hb')` 心跳；
  - 服务端 6s 没收到心跳即判定窗口已关闭，按 `ignore` 返回并关闭连接；
  - 这样点 X 不会把会话卡满 5 分钟。
- 启动窗口：自动探测 `msedge.exe` / `chrome.exe`，参数 `--app=<url> --window-size=460,340`；找不到浏览器 → 返回 `popup: 'unavailable'`（**不执行**）。
- 并发：同一时刻只显示一个小窗，后来的确认请求排队（上限 3），超限直接返回 `timeout`。
- 插件卸载 / DSH 退出：`server.close()`、结算未决请求、结束浏览器进程。

### 5.7 绑定：默认自动，可改绑

- **首次启动自动绑定**：`sessionId` 为空时，插件调用 `sessionController.list()`，挑最近活跃、非 `subagent`、非空白会话的 `sessionId`，立即写进插件状态文件 `%LOCALAPPDATA%\dsh-openless-task\state.json`，日志记 `auto-bound to <id> (saved)`。装完即可用，不需要手工绑定。
- 状态文件是绑定的权威来源（插件刚激活时 `configEditor.edit` 会被 HMR 事务拒绝，所以配置写回只做尽力而为）；优先级：配置 `sessionId` > 状态文件 > 本次自动绑定。
- 改绑工具 `openless_bind_here`：无参数；读取 `exec.agent.id`，写状态文件并尽力写回配置：

```js
writeState({ sessionId: id })            // 权威来源
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')   // 尽力而为，失败不影响绑定
await editor.edit(entry, current => ({ ...current, sessionId: id }))
```

- 返回 `{ sessionId, saved: true }`；`configEditor` 缺失或被更高层覆盖时返回 `saved: false` 并说明。
- 启动时校验：`sessionController.list()` 里找不到该 `sessionId` → 保留配置，投递时弹一次「绑定的会话已不存在，请重新绑定」小窗。
- 小窗页脚显示目标会话的标题/工作目录（来自 `sessionController.list()` 的 `cwd`），避免在错误工作区执行。

### 5.8 提示与可观测性

- 不写新的 Session 事件类型；状态只在配置与进程内存。
- 日志：文件变化、跳过原因、投递成功/失败、弹窗结果、超时、守卫拒绝。
- 空转写不弹窗（用户明确要求跳过）。

### 5.9 执行闸门（lib/gate.js）

- 仅在目标会话空闲时、投递前设置 `pending = { sessionId, at }`；忙闲读不到（`unknown`）按「忙」处理并照常挂旗标。`openless_task_confirm` 返回、投递失败、或 `pendingTtlMs` 到期时清除。
- 拒绝理由必须给出继续路径：直接调 `openless_task_confirm`（不经 `run_code`），只读改用 `read`/`grep`/`glob`。
- 注册 `ctx.tools.guard(exec => ...)`：
  - 仅当 `exec.agent?.id === pending.sessionId` 且未过期时生效；
  - 允许白名单：`openless_task_confirm`、`openless_bind_here`、只读工具（`read` / `grep` / `glob` / `web_search` / `web_fetch` / `ask_user_question` / `list_*`）；
  - 其余按 `actingTools` 拒绝，拒绝理由：「语音任务还没确认：请先调用 openless_task_confirm 让我确认。」
- 默认 `actingTools`：`run_code`、`bash`、`pwsh`、`write`、`edit`、`str_replace_editor`、`subagent`、`subagent_fork`、`workflow`，以及前缀 `remote_ssh_`、`terminal`、`schedule_`、`job_`、`create_bot`、`message_bot`、`send_wechat`。
- 不做「完全禁用所有工具」：识别任务通常需要读文件。

## 6. 失败模式与处理

| 情况 | 处理 |
|---|---|
| `history.json` 不存在 | 每 60s 最多告警一次，继续运行 |
| JSON 半写入 | debounce + 100ms 重试一次 |
| 转写为空 / `errorCode` | 跳过，日志记录 |
| 未绑定 / 绑定失效 | 错误小窗一次（浏览器可用时），不投递 |
| 会话正在跑别的回合 | 先等它空闲，再挂旗标并 `mode: 'queue'` 投递；超 `idleWaitMs` 则投递但不挂旗标 |
| 浏览器找不到 | 工具返回 `popup: 'unavailable'`，不执行 |
| 用户关窗 | 心跳判定 → 按 `ignore` 返回（≤6s） |
| 用户 5 分钟不点 | `timeout`，按「不执行」处理 |
| 模型没调用确认工具 | 旗标随 `pendingTtlMs` 到期失效，守卫放行 |
| 插件卸载 | 清 watcher、HTTP 服务、未决弹窗、旗标 |

## 7. 安全

- 本地服务只绑 `127.0.0.1`，token 单次有效。
- 只读 `history.json`；不写 Session 新事件类型。
- 任何失败路径默认「不执行」。

## 8. 验证计划

1. **单元**：过滤（空/失败/非 voice）、去重、composed 文本、超时、守卫（旗标期间拒绝 / 清除后放行）。
2. **集成（不依赖真语音）**：手工向 `history.json` 追加合法条目 → 投递 → 模型调用工具 → 小窗出现 → 执行 / 忽略 / 点 X 三条路径。
3. **安全验证**：在待确认期间让模型尝试 `pwsh`，必须被拒；点「执行」后同一命令必须放行。
4. **真机（前置：ASR 修好）**：右 Ctrl 说「列一下这个项目的目录结构」→ 确认小窗 → 执行。
5. **回归**：空条目、坏 JSON、重启 DSH（不回放）、浏览器缺失、绑定失效。

## 9. 我替你做的决定（可推翻）

- **闸门用工具守卫实现**，而不是只靠提示词——否则「确认」可能被模型绕过。
- **点 X = 忽略**，用心跳在 6s 内判定，不占满超时时间。
- **不是任务而是提问时**，让模型用 `summary` 带出答案给弹窗显示（同一套 UI，不额外做问答通道）。
- **弹窗页脚显示目标会话/工作目录**，降低在错误工作区执行的风险。
- **ASR 修复不在本项目范围**：先用合成条目验收；修好后再跑真机验收。

## 10. 已由用户决定 / 待用户批准

- 采用方案 A（独立小确认窗，不打开 DSH 控制台）。
- 热键沿用 OpenLess 的右 Ctrl，不新增全局热键。
- 空转写直接跳过。