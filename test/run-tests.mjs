/**
 * 单元/集成测试：不依赖真实浏览器与 DSH 运行时。
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGate, isExemptTool, matchesPattern } from '../lib/gate.js'
import { pickDefaultSession } from '../lib/default-session.js'
import { waitForIdle } from '../lib/idle.js'
import { renderPage } from '../lib/page.js'
import { createPopup } from '../lib/popup.js'
import { createWatcher, isUsableEntry, parseHistory } from '../lib/watcher.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return false
}

test('isUsableEntry 过滤空转写与失败条目', () => {
  const base = { id: 'x', source: 'voice', finalText: '你好', insertStatus: 'inserted', errorCode: null }
  assert.equal(isUsableEntry(base), true)
  assert.equal(isUsableEntry({ ...base, finalText: '' }), false)
  assert.equal(isUsableEntry({ ...base, finalText: '   ' }), false)
  assert.equal(isUsableEntry({ ...base, errorCode: 'polishFailed' }), false)
  assert.equal(isUsableEntry({ ...base, insertStatus: 'failed' }), false)
  assert.equal(isUsableEntry({ ...base, source: 'selection_polish' }), false)
  assert.equal(isUsableEntry({ id: 42, source: 'voice', finalText: 'x' }), false)
  assert.equal(isUsableEntry(null), false)
})

test('parseHistory 拒绝半写入内容', () => {
  assert.equal(parseHistory('[{"id":'), null)
  assert.equal(parseHistory('{"id":"a"}'), null)
  assert.deepEqual(parseHistory('[]'), [])
})

test('默认会话挑最近活跃的非子会话', () => {
  assert.equal(pickDefaultSession(null), '')
  assert.equal(pickDefaultSession([]), '')
  const items = [
    { sessionId: 'old', updatedAt: 100 },
    { sessionId: 'blank-one', updatedAt: 900, blank: true },
    { sessionId: 'child', updatedAt: 950, origin: 'subagent' },
    { sessionId: 'newest', updatedAt: 800 },
    { sessionId: '', updatedAt: 1000 },
  ]
  assert.equal(pickDefaultSession(items), 'newest')
})

test('matchesPattern 支持精确与前缀', () => {
  assert.equal(matchesPattern('bash', ['bash']), true)
  assert.equal(matchesPattern('bash', ['run_code']), false)
  assert.equal(matchesPattern('remote_ssh_exec', ['remote_ssh_*']), true)
  assert.equal(matchesPattern('terminal_create', ['terminal*']), true)
  assert.equal(matchesPattern('job_kill', ['job_*']), true)
})

test('闸门只拦绑定会话里的动手类工具', () => {
  const config = { pendingTtlMs: 5000, actingTools: ['bash', 'remote_ssh_*'] }
  const gate = createGate({ read: (key) => config[key], log: () => {} })
  gate.arm('s1')
  const denied = gate.check({ name: 'bash', agent: { id: 's1' } })
  assert.equal(denied?.info?.code, 'OPENLESS_PENDING_CONFIRM')
  assert.equal(gate.check({ name: 'remote_ssh_exec', agent: { id: 's1' } })?.info?.code, 'OPENLESS_PENDING_CONFIRM')
  assert.equal(gate.check({ name: 'read', agent: { id: 's1' } }), undefined)
  assert.equal(gate.check({ name: 'openless_task_confirm', agent: { id: 's1' } }), undefined)
  assert.equal(gate.check({ name: 'bash', agent: { id: 's2' } }), undefined)
  gate.clear()
  assert.equal(gate.check({ name: 'bash', agent: { id: 's1' } }), undefined)
})

test('闸门在 TTL 后自动失效', async () => {
  const config = { pendingTtlMs: 100, actingTools: ['bash'] }
  const gate = createGate({ read: (key) => config[key], log: () => {} })
  gate.arm('s1')
  assert.ok(gate.check({ name: 'bash', agent: { id: 's1' } }))
  await sleep(160)
  assert.equal(gate.check({ name: 'bash', agent: { id: 's1' } }), undefined)
})

test('页面渲染会转义并带出两个按钮', () => {
  const html = renderPage({
    token: 'tok',
    kind: 'confirm',
    summary: '<script>alert(1)</script>',
    tasks: ['a<b'],
    transcript: '原文',
    sessionId: 's1',
    cwd: 'D:\\work',
    timeoutMs: 300000,
  })
  assert.ok(html.includes('语音任务确认'))
  assert.ok(html.includes('data-choice="execute"'))
  assert.ok(html.includes('data-choice="ignore"'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('5 分钟内不选'))
})

test('提示模式只有一个关闭按钮', () => {
  const html = renderPage({ token: 'tok', kind: 'notice', summary: '未绑定会话', message: '去绑定', timeoutMs: 120000 })
  assert.ok(html.includes('data-choice="ignore"'))
  assert.ok(!html.includes('data-choice="execute"'))
})

test('watcher 只上报新的可用条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openless-task-'))
  const file = join(dir, 'history.json')
  const entry = (id, finalText, extra = {}) => ({
    id,
    source: 'voice',
    finalText,
    insertStatus: 'inserted',
    errorCode: null,
    ...extra,
  })
  writeFileSync(file, JSON.stringify([entry('a', '旧的一条')]))
  const seen = []
  const watcher = createWatcher({
    path: () => file,
    pollMs: () => 50,
    log: () => {},
    onEntry: (item) => seen.push(item.id),
  })
  const stop = watcher.start()
  await sleep(120)
  assert.deepEqual(seen, [])

  writeFileSync(file, JSON.stringify([entry('b', '新的任务'), entry('a', '旧的一条')]))
  assert.ok(await waitUntil(() => seen.includes('b')), 'new entry should be delivered')
  assert.deepEqual(seen, ['b'])

  writeFileSync(file, JSON.stringify([
    entry('c', ''),
    entry('d', '失败', { errorCode: 'polishFailed' }),
    entry('e', '成功但 insert 失败', { insertStatus: 'failed' }),
    entry('b', '新的任务'),
    entry('a', '旧的一条'),
  ]))
  await sleep(250)
  assert.deepEqual(seen, ['b'])
  stop()
})

test('弹窗：点击执行返回 execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openless-popup-'))
  const fakeBrowser = join(dir, 'msedge.exe')
  writeFileSync(fakeBrowser, '')
  const popup = createPopup({
    read: (key) => ({ browserPath: fakeBrowser, confirmTimeoutMs: 2000 })[key],
    log: () => {},
    launch: (_browser, url) => {
      void (async () => {
        await sleep(30)
        const html = await (await fetch(url)).text()
        assert.ok(html.includes('data-choice="execute"'))
        const parsed = new URL(url)
        const token = parsed.searchParams.get('t')
        await fetch(`http://127.0.0.1:${parsed.port}/answer?t=${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ choice: 'execute' }),
        })
      })()
      return { once() {}, unref() {} }
    },
  })
  try {
    const result = await popup.show({ kind: 'confirm', summary: '测试', tasks: ['做一件事'], transcript: '原文' })
    assert.deepEqual(result, { choice: 'execute', popup: 'shown' })
  } finally {
    popup.dispose()
  }
})

test('弹窗：超时按 timeout 处理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openless-popup-'))
  const fakeBrowser = join(dir, 'msedge.exe')
  writeFileSync(fakeBrowser, '')
  const popup = createPopup({
    read: (key) => ({ browserPath: fakeBrowser, confirmTimeoutMs: 300 })[key],
    log: () => {},
    launch: () => ({ once() {}, unref() {} }),
  })
  try {
    const result = await popup.show({ kind: 'confirm', summary: '测试', tasks: ['x'], transcript: '' })
    assert.deepEqual(result, { choice: 'timeout', popup: 'shown' })
  } finally {
    popup.dispose()
  }
})

test('弹窗：找不到浏览器时不执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openless-popup-'))
  mkdirSync(join(dir, 'empty'), { recursive: true })
  const original = {
    ProgramFiles: process.env.ProgramFiles,
    ProgramFilesX86: process.env['ProgramFiles(x86)'],
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  }
  process.env.ProgramFiles = join(dir, 'empty')
  process.env['ProgramFiles(x86)'] = join(dir, 'empty')
  process.env.LOCALAPPDATA = join(dir, 'empty')
  const popup = createPopup({
    read: (key) => ({ browserPath: '', confirmTimeoutMs: 500 })[key],
    log: () => {},
    launch: () => {
      throw new Error('should not launch')
    },
  })
  try {
    const result = await popup.show({ kind: 'confirm', summary: '测试', tasks: ['x'], transcript: '' })
    assert.deepEqual(result, { choice: 'ignore', popup: 'unavailable' })
  } finally {
    popup.dispose()
    process.env.ProgramFiles = original.ProgramFiles
    process.env['ProgramFiles(x86)'] = original.ProgramFilesX86
    process.env.LOCALAPPDATA = original.LOCALAPPDATA
  }
})

test('拒绝理由把「怎么继续」说清楚', () => {
  const config = { pendingTtlMs: 5000, actingTools: ['run_code'] }
  const gate = createGate({ read: (key) => config[key], log: () => {} })
  gate.arm('s1')
  const denied = gate.check({ name: 'run_code', agent: { id: 's1' } })
  assert.ok(denied.reason.includes('openless_task_confirm'))
  assert.ok(denied.reason.includes('read'))
  assert.ok(denied.reason.includes('grep'))
  // 只读工具与豁免工具始终放行，这正是解锁的唯一通道。
  assert.equal(gate.check({ name: 'read', agent: { id: 's1' } }), undefined)
  assert.equal(gate.check({ name: 'openless_task_confirm', agent: { id: 's1' } }), undefined)
  assert.equal(gate.check({ name: 'openless_bind_here', agent: { id: 's1' } }), undefined)
  assert.equal(isExemptTool('openless_task_confirm'), true)
  assert.equal(isExemptTool('run_code'), false)
})

test('等空闲：空闲会话立即返回，不挂旗标也不等待', async () => {
  const result = await waitForIdle({ isRunning: async () => false, timeoutMs: 1000, intervalMs: 10 })
  assert.deepEqual(result, { idle: true, waitedMs: 0, unknown: false })
})

test('等空闲：忙的时候等到空闲为止', async () => {
  let calls = 0
  const result = await waitForIdle({
    isRunning: async () => { calls += 1; return calls < 3 },
    timeoutMs: 2000,
    intervalMs: 5,
  })
  assert.equal(result.idle, true)
  assert.equal(result.unknown, false)
  assert.equal(calls, 3)
})

test('等空闲：一直忙就超时，返回 idle=false', async () => {
  let clock = 0
  const result = await waitForIdle({
    isRunning: async () => true,
    timeoutMs: 100,
    intervalMs: 50,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.equal(result.idle, false)
  assert.equal(result.unknown, false)
})

test('等空闲：0 预算时忙就立刻放弃等待', async () => {
  const result = await waitForIdle({ isRunning: async () => true, timeoutMs: 0, intervalMs: 10 })
  assert.equal(result.idle, false)
})

test('等空闲：读不到忙闲时标记 unknown，由调用方决定是否挂旗标', async () => {
  const result = await waitForIdle({
    isRunning: async () => { throw new Error('list failed') },
    timeoutMs: 100,
    intervalMs: 10,
  })
  assert.equal(result.unknown, true)
})
