/**
 * 确认小窗：本地回环 HTTP 服务 + 浏览器 --app 窗口 + 等待用户选择。
 * @module dsh-openless-task/popup
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { renderPage } from './page.js'

/** 浏览器启动后等首次心跳的宽限。 */
const LAUNCH_GRACE_MS = 15000
/** 心跳超过这个时间没来，就认为窗口被关掉了。 */
const HEARTBEAT_TIMEOUT_MS = 6000
/** 同时排队等待弹窗的上限。 */
const QUEUE_LIMIT = 3
/** 已结算记录的保留时间。 */
const FINISHED_TTL_MS = 5 * 60 * 1000
/** 提示类窗口的等待上限。 */
const NOTICE_TIMEOUT_MS = 120000

/**
 * 找一个可用的 Chromium 内核浏览器。
 * @param {string} configured - 配置里指定的路径。
 * @returns {string} 可执行文件路径；找不到时为空串。
 */
export function findBrowser(configured) {
  /** @type {string[]} */
  const candidates = []
  const trimmed = String(configured ?? '').trim()
  if (trimmed) candidates.push(trimmed)
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  candidates.push(
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  )
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 忽略无权限路径
    }
  }
  return ''
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} value - 响应体。
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读一个很小的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析结果。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 8192) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(body)
        resolve(value && typeof value === 'object' ? value : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * 用浏览器打开一个 --app 窗口。
 * @param {string} browser - 浏览器可执行文件。
 * @param {string} url - 页面地址。
 * @returns {{ once: Function, unref: Function }} 子进程句柄。
 */
export function launchBrowser(browser, url) {
  const child = spawn(browser, [`--app=${url}`, '--window-size=460,340'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child
}

/**
 * 创建弹窗服务。
 * @param {object} options - 配置。
 * @param {(key: string) => unknown} options.read - 实时配置读取。
 * @param {(...parts: unknown[]) => void} options.log - 日志。
 * @param {(browser: string, url: string) => { once?: Function, unref?: Function }} [options.launch] - 打开窗口的函数（测试可替换）。
 * @returns {{ show: (payload: object) => Promise<{ choice: string, popup: string }>, dispose: () => void }} 服务。
 */
export function createPopup({ read, log, launch = launchBrowser }) {
  /** @type {import('node:http').Server | null} */
  let server = null
  let port = 0
  let disposed = false
  let sweepTimer = null
  /** @type {Map<string, any>} */
  const records = new Map()
  /** @type {any[]} */
  const queue = []
  /** @type {any | null} */
  let active = null

  /** 确保本地服务已启动。 */
  async function ensureServer() {
    if (server !== null) return port
    server = http.createServer(handle)
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server?.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server?.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    port = server.address().port
    log('popup server listening on 127.0.0.1:' + port)
    return port
  }

  /** 结算一个请求。 */
  function settle(record, choice, popupKind) {
    if (record.state !== 'pending') return
    record.state = choice
    record.finishedAt = Date.now()
    clearTimeout(record.timer)
    record.resolve?.({ choice, popup: popupKind })
    if (active === record) active = null
    pump()
  }

  /** 启动下一个排队请求。 */
  async function pump() {
    if (disposed || active !== null) return
    const record = queue.shift()
    if (!record) return
    active = record
    const browser = findBrowser(String(read('browserPath') ?? ''))
    if (!browser) {
      log('no chromium browser found')
      settle(record, 'ignore', 'unavailable')
      return
    }
    try {
      const listenPort = await ensureServer()
      const url = `http://127.0.0.1:${listenPort}/?t=${record.token}`
      record.launchedAt = Date.now()
      record.shown = true
      const child = launch(browser, url)
      child.once?.('error', (error) => {
        log('browser launch failed', error)
        settle(record, 'ignore', 'unavailable')
      })
      child.unref?.()
      ensureSweep()
      log('popup opened', browser)
    } catch (error) {
      log('popup failed', error)
      settle(record, 'ignore', 'unavailable')
    }
  }

  /** 处理 HTTP 请求。 */
  function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const token = url.searchParams.get('t') ?? ''
    const record = records.get(token)
    if (!record) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      const html = renderPage({ ...record.payload, token })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : html)
      return
    }
    if (url.pathname === '/hb' && req.method === 'POST') {
      record.lastBeat = Date.now()
      sendJson(res, 200, { state: record.state })
      return
    }
    if (url.pathname === '/answer' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const choice = body?.choice === 'execute' ? 'execute' : 'ignore'
          if (record.state === 'pending') settle(record, choice, record.shown ? 'shown' : 'unavailable')
          sendJson(res, 200, { ok: true, state: record.state })
        })
        .catch(() => {
          sendJson(res, 400, { ok: false })
        })
      return
    }
    res.writeHead(404)
    res.end()
  }

  /** 定期检查：窗口被关掉就按忽略处理；清理过期记录。 */
  function sweep() {
    const now = Date.now()
    for (const [token, record] of records) {
      if (record.state === 'pending') {
        if (record === active) {
          if (record.lastBeat) {
            if (now - record.lastBeat > HEARTBEAT_TIMEOUT_MS) {
              log('popup window closed; treating as ignore')
              settle(record, 'ignore', record.shown ? 'shown' : 'unavailable')
            }
          } else if (record.launchedAt && now - record.launchedAt > LAUNCH_GRACE_MS) {
            log('popup never loaded; treating as ignore')
            settle(record, 'ignore', record.shown ? 'shown' : 'unavailable')
          }
        }
      } else if (record.finishedAt && now - record.finishedAt > FINISHED_TTL_MS) {
        records.delete(token)
      }
    }
    if (records.size === 0 && sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }

  /** 确保清理定时器已启动。 */
  function ensureSweep() {
    if (sweepTimer !== null) return
    sweepTimer = setInterval(sweep, 2000)
    sweepTimer.unref?.()
  }

  return {
    /**
     * 显示一个窗口并等待结果。
     * @param {object} payload - 页面数据。
     * @returns {Promise<{ choice: string, popup: string }>} 结果。
     */
    show(payload) {
      if (disposed) return Promise.resolve({ choice: 'ignore', popup: 'unavailable' })
      if (queue.length >= QUEUE_LIMIT) {
        log('popup queue full; ignoring this request')
        return Promise.resolve({ choice: 'timeout', popup: 'shown' })
      }
      const kind = payload.kind === 'notice' ? 'notice' : 'confirm'
      const timeoutMs = kind === 'notice'
        ? NOTICE_TIMEOUT_MS
        : Number(read('confirmTimeoutMs')) || 300000
      const token = randomBytes(16).toString('hex')
      /** @type {any} */
      const record = {
        token,
        payload: { ...payload, kind, timeoutMs },
        state: 'pending',
        lastBeat: 0,
        launchedAt: 0,
        shown: false,
        finishedAt: 0,
        resolve: null,
        timer: null,
      }
      records.set(token, record)
      const promise = new Promise((resolve) => {
        record.resolve = resolve
      })
      record.timer = setTimeout(() => {
        settle(record, kind === 'notice' ? 'ignore' : 'timeout', record.shown ? 'shown' : 'unavailable')
      }, timeoutMs)
      record.timer.unref?.()
      queue.push(record)
      pump()
      return promise
    },
    dispose() {
      disposed = true
      for (const record of records.values()) {
        if (record.state === 'pending') settle(record, 'ignore', 'unavailable')
      }
      queue.length = 0
      if (sweepTimer !== null) clearInterval(sweepTimer)
      sweepTimer = null
      try {
        server?.close()
      } catch {
        // 忽略
      }
      server = null
    },
  }
}
