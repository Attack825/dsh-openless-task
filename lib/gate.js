/**
 * 执行闸门：语音任务确认前，拒绝「动手类」工具。
 *
 * 关键约束：旗标只能属于「本次语音任务开启的那一个回合」。会话正忙时先挂旗标，
 * 会误伤用户上一轮的回合——那一轮的模型并没有看到语音原文，只能反复重试
 * run_code/pwsh，确认卡片则永远不会被调用。投递侧因此先等会话空闲（lib/idle.js），
 * 再挂旗标并投递；等不到就干脆不挂，宁可不拦，也不误伤。
 * @module dsh-openless-task/gate
 */

/** 守卫永远放行的工具名：确认与绑定本身不能被执行闸门挡住。 */
export const EXEMPT_TOOLS = ['openless_task_confirm', 'openless_bind_here']

/** 命中豁免时返回 true。 */
export function isExemptTool(name) {
  return EXEMPT_TOOLS.includes(String(name ?? ''))
}

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

/** 拒绝理由：告诉模型「怎么继续」，而不只是「不许动」。 */
const DENY_REASON = '语音任务还没确认：请直接调用 openless_task_confirm 把任务清单交给我确认（它不需要经过 run_code，也没有被拦）。'
  + '只读检查请改用 read / grep / glob（不受限制）；确认前 run_code、pwsh、write 等动手类工具一律拒绝。'

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
      if (isExemptTool(name)) return undefined
      const configured = read('actingTools')
      const patterns = Array.isArray(configured) ? configured : []
      if (!matchesPattern(name, patterns)) return undefined
      return {
        reason: DENY_REASON,
        info: { name: 'OpenLessPendingConfirm', code: 'OPENLESS_PENDING_CONFIRM' },
      }
    },
  }
}