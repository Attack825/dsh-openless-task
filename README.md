# dsh-openless-task

把 OpenLess 说的话，变成固定 DSH 会话里的一项任务；动手之前先弹一个小窗让你确认。

- Host-only DSH 插件，无客户端代码、无第三方运行时依赖。
- 用 OpenLess 自己的全局热键触发，不抢 DSH 的键盘。
- 确认前由工具守卫拦住动手类工具；点「执行」才放行。

## 它做什么

1. 监听 OpenLess 的 `history.json`（默认 `%APPDATA%\OpenLess\history.json`）。
2. 只接手**新的、有正文的**语音条目：`finalText` 为空、`errorCode` 非空、`insertStatus === "failed"`、或 `source` 不是 `voice` 的条目直接跳过。
3. 把转写投递到你绑定的那个 DSH 会话（`sessionController.prompt`，冷会话会自动 resume）。
4. 模型先列出任务清单，再调用 `openless_task_confirm`：插件弹出一个独立小窗，只有「执行」和「忽略」。
5. 在你选择之前，工具守卫拒绝 `run_code`、`bash`、`pwsh`、`write`、`edit`、`subagent` 等动手类工具；点「执行」后放行。
6. 没有可执行任务时**不弹窗**，模型只在会话里回答。

小窗是插件自己的本地页面（`127.0.0.1` 随机端口 + 一次性 token），用 Edge 或 Chrome 的 `--app` 模式打开，不占用 DSH 窗口。关掉小窗等同于「忽略」，6 秒内生效。

## 安装

在 DSH 的「插件管理」里添加本目录（本地目录安装），然后启用。

装完即生效，无需重启。

前置：Windows 上的 OpenLess 正在运行，并且转写正常；系统里有 Edge 或 Chrome。

## 用法

1. 安装并启用本插件。
2. **首次启动会自动绑定最近活跃的会话**，会话 id 存进 `%LOCALAPPDATA%\dsh-openless-task\state.json`——装完就能用，不需要手工绑定。想换会话时，在那个会话里说一句「绑定 OpenLess 到这里」（调用 `openless_bind_here`）即可改绑。
3. 用 OpenLess 的全局热键说话。说完、转写落盘后，任务会出现在绑定的会话；需要确认时小窗会自动弹出。

## 待确认状态怎么工作（别把自己锁死）

插件的闸门只在**一个回合**里生效：这条语音自己的回合。

- 收到语音时如果会话正忙（你上一轮还在跑），插件先等它空闲，再挂「待确认」旗标并投递——这样被拦的一定是看到语音原文的那一轮。
- 一直忙到 `idleWaitMs`（默认 2 分钟）就照投不挂旗标：宁可这条少一层拦截，也不把你正在跑的回合锁死。
- 旗标最多挂 `pendingTtlMs`（默认 3 分钟），到期自动失效；确认工具返回（执行/忽略/超时/浏览器不可用）也会立即清除。
- `openless_task_confirm` 与 `openless_bind_here` 永远不被闸门拦；只读工具（`read` / `grep` / `glob` 等）也一直放行。被拦只可能是 `run_code` / `pwsh` / `write` 这类动手工具。

排查时看 `%LOCALAPPDATA%\dsh-openless-task\openless-task.log`：`gate armed` → `popup opened` → `confirm result ...` 三段齐全才算走完；只有 `gate denied` 没有 `popup opened`，说明模型没调确认工具，不是卡片打不开。

## 卸载

在插件管理里移除本插件即可；它不写任何 Session 事件，也不留后台进程。状态文件和日志在 `%LOCALAPPDATA%\dsh-openless-task\`，可一并删除。