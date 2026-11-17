/**
 * 插件自己的运行状态（目前只有绑定的会话 id）。
 *
 * 配置写回（configEditor）在插件刚激活时会被 HMR 事务拒绝，所以绑定结果以这个
 * 状态文件为准；配置里的 `sessionId` 仍然优先，方便手工固定。
 * @module dsh-openless-task/state
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 状态目录。
 * @returns {string} 绝对路径。
 */
export function stateDir() {
  return join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-openless-task')
}

/**
 * 状态文件位置。
 * @returns {string} 绝对路径。
 */
export function statePath() {
  return join(stateDir(), 'state.json')
}

/**
 * 读状态；缺失或损坏时返回空对象。
 * @returns {Record<string, unknown>} 状态。
 */
export function readState() {
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * 合并写入状态。
 * @param {Record<string, unknown>} patch - 要写入的字段。
 * @returns {boolean} 是否写入成功。
 */
export function writeState(patch) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(statePath(), `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
