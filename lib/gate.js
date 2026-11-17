/**
 * 执行闸门：语音任务确认前，拒绝「动手类」工具。
 * @module dsh-openless-task/gate
 */

/**
 * 名字是否命中模式；`*` 结尾表示前缀匹配。
 * @param {string} name - 工具名。
 * @param {readonly string[]} patterns - 模式表。
 * @returns {boolean} 是否命中。
 */
export function matchesPattern(name, patterns) {
  const value = String(name ?? '')
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (pattern.endsWith('*')) {
      if (value.startsWith(pattern.slice(0, -1))) return true
      continue
    }
    if (value === pattern) return true
  }
  return false
}

/**
 * 创建闸门。
 * @param {object} options - 配置。
 * @param {(key: string) => unknown} options.read - 实时配置读取。
 * @param {(...parts: unknown[]) => void} options.log - 日志。
 * @returns {{ arm: (sessionId: string) => void, clear: () => void, check: (exec: unknown) => object | undefined, isPending: () => boolean }} 闸门。
 */
export function createGate({ read, log }) {
  /** @type {{ sessionId: string, at: number } | null} */
  let pending = null

  /** 读取最长挂起时间。 */
  function ttl() {
    const value = Number(read('pendingTtlMs'))
    return Number.isFinite(value) && value > 0 ? value : 180000
  }

  /** 返回仍然有效的旗标；过期即清除。 */
  function current() {
    if (pending === null) return null
    if (Date.now() - pending.at > ttl()) {
      log('pending flag expired')
      pending = null
      return null
    }
    return pending
  }

  return {
    arm(sessionId) {
      pending = { sessionId: String(sessionId ?? ''), at: Date.now() }
      log('gate armed for', pending.sessionId)
    },
    clear() {
      if (pending !== null) log('gate cleared')
      pending = null
    },
    isPending() {
      return current() !== null
    },
    check(exec) {
      const flag = current()
      if (flag === null) return undefined
      const agentId = String(exec?.agent?.id ?? '')
      if (agentId === '' || agentId !== flag.sessionId) return undefined
      const name = String(exec?.name ?? '')
      if (name === 'openless_task_confirm' || name === 'openless_bind_here') return undefined
      const configured = read('actingTools')
      const patterns = Array.isArray(configured) ? configured : []
      if (!matchesPattern(name, patterns)) return undefined
      return {
        reason: '语音任务还没确认：请先调用 openless_task_confirm 让我确认；我点「执行」后再动手。',
        info: { name: 'OpenLessPendingConfirm', code: 'OPENLESS_PENDING_CONFIRM' },
      }
    },
  }
}
