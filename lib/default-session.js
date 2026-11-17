/**
 * 挑一个默认会话：最近活跃、非子会话、非空白会话。
 * @module dsh-openless-task/default-session
 */

/**
 * 从会话列表里挑默认会话。
 * @param {unknown} items - `sessionController.list()` 的 items。
 * @returns {string} 会话 id；没有可用会话时为空串。
 */
export function pickDefaultSession(items) {
  if (!Array.isArray(items)) return ''
  const usable = items.filter((item) => item != null
    && typeof item === 'object'
    && typeof item.sessionId === 'string'
    && item.sessionId.length > 0
    && item.origin !== 'subagent'
    && item.blank !== true)
  usable.sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
  return usable.length > 0 ? usable[0].sessionId : ''
}
