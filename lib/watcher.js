/**
 * history.json 监听：只取新的、有正文的语音条目，跳过空转写与失败条目。
 * @module dsh-openless-task/watcher
 */
import { readFileSync, watch } from 'node:fs'
import { dirname } from 'node:path'

/** 去重窗口。 */
const SEEN_LIMIT = 200

/**
 * 判断一条历史记录是否值得投递给 DSH。
 * @param {unknown} entry - history.json 里的一条记录。
 * @returns {boolean} 是否可用。
 */
export function isUsableEntry(entry) {
  if (entry == null || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false
  if (entry.source !== 'voice') return false
  if (typeof entry.finalText !== 'string' || entry.finalText.trim().length === 0) return false
  if (entry.errorCode != null && entry.errorCode !== '') return false
  if (entry.insertStatus === 'failed') return false
  return true
}

/**
 * 解析 history.json 文本；坏 JSON（半写入）返回 null。
 * @param {string} raw - 文件内容。
 * @returns {unknown[] | null} 记录数组。
 */
export function parseHistory(raw) {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 创建监听器。
 * @param {object} options - 配置。
 * @param {() => string} options.path - 历史文件路径（每次读取实时配置）。
 * @param {() => number} options.pollMs - 轮询周期。
 * @param {(...parts: unknown[]) => void} options.log - 日志。
 * @param {(entry: { id: string, finalText: string }) => void | Promise<void>} options.onEntry - 新条目回调。
 * @returns {{ start: () => () => void }} 监听器。
 */
export function createWatcher({ path, pollMs, log, onEntry }) {
  /** @type {Set<string>} */
  const seen = new Set()
  let baselined = false
  let stopped = false
  let timer = null
  let watcher = null
  let watchingDir = ''
  let debounceTimer = null
  /** @type {Promise<void>} */
  let chain = Promise.resolve()

  /** 把一条新记录排队交给 onEntry，保持顺序。 */
  function emit(entry) {
    chain = chain.then(async () => {
      try {
        await onEntry(entry)
      } catch (error) {
        log('entry failed', error)
      }
    })
  }

  /** 读一次文件并处理新条目。 */
  function snap() {
    if (stopped) return
    const file = path()
    if (!file) return
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') log('history read failed', error?.message ?? error)
      return
    }
    const list = parseHistory(raw)
    if (list === null) return
    if (!baselined) {
      for (const entry of list) {
        if (entry && typeof entry.id === 'string') seen.add(entry.id)
      }
      baselined = true
      log('baseline', seen.size, 'entries')
      ensureWatch(dirname(file))
      return
    }
    /** @type {Array<{ id: string, finalText: string }>} */
    const fresh = []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]
      if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue
      seen.add(entry.id)
      if (isUsableEntry(entry)) fresh.push({ id: entry.id, finalText: entry.finalText })
    }
    trimSeen()
    for (const entry of fresh) {
      log('new voice entry', entry.id, entry.finalText.length, 'chars')
      emit(entry)
    }
  }

  /** 限制去重集合大小。 */
  function trimSeen() {
    if (seen.size <= SEEN_LIMIT) return
    const overflow = seen.size - SEEN_LIMIT
    let dropped = 0
    for (const id of seen) {
      if (dropped >= overflow) break
      seen.delete(id)
      dropped += 1
    }
  }

  /** 目录级 fs.watch 作为低延迟补充（OpenLess 可能原子替换文件）。 */
  function ensureWatch(dir) {
    if (watcher !== null || !dir || dir === watchingDir) return
    try {
      watcher = watch(dir, { persistent: false }, () => {
        if (stopped) return
        if (debounceTimer !== null) return
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          snap()
        }, 300)
        debounceTimer.unref?.()
      })
      watcher.on?.('error', () => {
        try {
          watcher?.close()
        } catch {
          // 忽略
        }
        watcher = null
        watchingDir = ''
      })
      watchingDir = dir
    } catch (error) {
      log('watch unavailable', error?.message ?? error)
      watcher = null
    }
  }

  return {
    start() {
      stopped = false
      snap()
      timer = setInterval(snap, Math.max(500, Number(pollMs()) || 1000))
      timer.unref?.()
      return () => {
        stopped = true
        if (timer !== null) clearInterval(timer)
        if (debounceTimer !== null) clearTimeout(debounceTimer)
        timer = null
        debounceTimer = null
        try {
          watcher?.close()
        } catch {
          // 忽略
        }
        watcher = null
      }
    },
  }
}
