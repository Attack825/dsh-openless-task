/**
 * 确认小窗的页面渲染（自包含 HTML，无外部资源）。
 * @module dsh-openless-task/page
 */

/**
 * HTML 转义。
 * @param {unknown} value - 任意值。
 * @returns {string} 转义后的文本。
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 渲染确认页。
 * @param {object} payload - 页面数据。
 * @param {string} payload.token - 一次性 token。
 * @param {'confirm' | 'notice'} payload.kind - 模式。
 * @param {string} payload.summary - 一句话摘要 / 标题。
 * @param {string} [payload.message] - notice 正文。
 * @param {string[]} [payload.tasks] - 任务清单。
 * @param {string} [payload.transcript] - 语音原文。
 * @param {string} [payload.sessionId] - 目标会话。
 * @param {string} [payload.cwd] - 目标工作目录。
 * @param {number} [payload.timeoutMs] - 等待上限。
 * @returns {string} HTML。
 */
export function renderPage(payload) {
  const kind = payload.kind === 'notice' ? 'notice' : 'confirm'
  const summary = escapeHtml(payload.summary)
  const message = escapeHtml(payload.message ?? '')
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const transcript = escapeHtml(payload.transcript ?? '')
  const minutes = Math.max(1, Math.round((Number(payload.timeoutMs) || 300000) / 60000))
  const metaParts = []
  if (payload.sessionId) metaParts.push(`会话 ${escapeHtml(payload.sessionId)}`)
  if (payload.cwd) metaParts.push(escapeHtml(payload.cwd))
  const meta = metaParts.join(' · ')

  const taskList = tasks.length
    ? `<ul class="tasks">${tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join('')}</ul>`
    : ''

  const transcriptBlock = transcript
    ? `<details class="transcript"><summary>语音原文</summary><p>${transcript}</p></details>`
    : ''

  const actions = kind === 'notice'
    ? '<button class="btn ghost" data-choice="ignore">关闭</button>'
    : [
      '<button class="btn ghost" data-choice="ignore">忽略</button>',
      '<button class="btn primary" data-choice="execute">执行</button>',
    ].join('')

  const hint = kind === 'notice'
    ? '这是一条提示，不会执行任何操作。'
    : `${minutes} 分钟内不选，按「忽略」处理。`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${kind === 'notice' ? 'OpenLess 提示' : '语音任务确认'}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 18px 14px;
    font: 14px/1.55 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #16181d; background: #f7f8fa;
    display: flex; flex-direction: column; height: 100vh;
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: .02em;
    color: #2f6fed; background: #e8efff; border-radius: 999px; padding: 2px 8px;
  }
  .head h1 { font-size: 13px; font-weight: 600; margin: 0; color: #5b6170; }
  .summary { font-size: 16px; font-weight: 600; margin: 0 0 10px; color: #111318; }
  .summary.notice { font-size: 15px; }
  .message { margin: 0 0 10px; color: #3d4250; white-space: pre-wrap; }
  .tasks { margin: 0 0 10px; padding-left: 20px; color: #23262e; }
  .tasks li { margin: 2px 0; }
  .transcript { margin-top: auto; font-size: 12px; color: #6b7280; }
  .transcript summary { cursor: pointer; user-select: none; }
  .transcript p { margin: 6px 0 0; white-space: pre-wrap; max-height: 84px; overflow: auto; color: #4b5160; }
  .meta { font-size: 11px; color: #8a90a0; margin: 12px 0 8px; word-break: break-all; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn {
    font: inherit; font-weight: 600; font-size: 13px;
    border-radius: 9px; padding: 7px 18px; cursor: pointer; border: 1px solid transparent;
  }
  .btn.primary { background: #2f6fed; color: #fff; }
  .btn.primary:hover { background: #255fd6; }
  .btn.ghost { background: #fff; color: #3d4250; border-color: #d8dbe3; }
  .btn.ghost:hover { background: #eef0f4; }
  .hint { font-size: 11px; color: #9aa0ae; margin-right: auto; align-self: center; }
  .row { display: flex; align-items: center; gap: 8px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8eaf0; background: #15171c; }
    .badge { color: #8fb0ff; background: #1f2a44; }
    .head h1 { color: #9aa2b4; }
    .summary { color: #f2f4f8; }
    .message, .tasks li { color: #c9cedb; }
    .transcript, .meta { color: #8c93a5; }
    .transcript p { color: #aeb4c4; }
    .btn.ghost { background: #1d2027; color: #d6dae4; border-color: #333844; }
    .btn.ghost:hover { background: #262a33; }
  }
</style>
</head>
<body>
  <div class="head"><span class="badge">OpenLess</span><h1>${kind === 'notice' ? '提示' : '语音任务确认'}</h1></div>
  <p class="summary${kind === 'notice' ? ' notice' : ''}">${summary}</p>
  ${message ? `<p class="message">${message}</p>` : ''}
  ${taskList}
  ${transcriptBlock}
  <div class="meta">${meta}</div>
  <div class="row">
    <span class="hint">${hint}</span>
    <div class="actions">${actions}</div>
  </div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(payload.token)};
  var done = false;
  function finish(choice) {
    if (done) return;
    done = true;
    var body = JSON.stringify({ choice: choice });
    fetch('/answer?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body
    }).catch(function () {}).then(function () {
      window.close();
      setTimeout(function () { window.close(); }, 150);
    });
  }
  var buttons = document.querySelectorAll('[data-choice]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) {
      finish(event.currentTarget.getAttribute('data-choice'));
    });
  }
  setInterval(function () {
    if (done) return;
    fetch('/hb?t=' + encodeURIComponent(TOKEN), { method: 'POST' })
      .then(function (response) { return response.json(); })
      .then(function (state) {
        if (state && state.state && state.state !== 'pending') {
          done = true;
          window.close();
        }
      })
      .catch(function () {});
  }, 2000);
})();
</script>
</body>
</html>`
}
