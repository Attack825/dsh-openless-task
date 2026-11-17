/**
 * 等绑定的会话空闲：语音旗标只能属于本次语音任务自己的回合。
 *
 * `sessionController.list()` 的会话摘要带 `running`（见 Host 侧 summaryFor），
 * 所以「忙」是可观测的。等待期间不投递、不挂旗标；用户上一轮回合因此不会被误拦。
 * @module dsh-openless-task/idle
 */

/**
 * 轮询直到会话空闲或超时。
 * @param {object} options - 配置。
 * @param {() => Promise<boolean>} options.isRunning - 读取会话是否在跑回合；抛错视为「未知」。
 * @param {number} options.timeoutMs - 最长等待（0 = 不等待）。
 * @param {number} [options.intervalMs] - 轮询周期。
 * @param {() => number} [options.now] - 时钟（测试用）。
 * @param {(ms: number) => Promise<void>} [options.sleep] - 等待函数（测试用）。
 * @returns {Promise<{ idle: boolean, waitedMs: number, unknown: boolean }>} 结果。
 */
export async function waitForIdle({
  isRunning,
  timeoutMs,
  intervalMs = 500,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
  const startedAt = now()
  /** 读一次忙闲；读失败时返回 null 表示「未知」。 */
  const busy = async () => {
    try {
      return (await isRunning()) === true
    } catch {
      return null
    }
  }
  let state = await busy()
  if (state === null) return { idle: false, waitedMs: 0, unknown: true }
  while (state === true) {
    if (now() - startedAt >= budget) break
    await sleep(Math.min(Math.max(50, intervalMs), budget - (now() - startedAt)))
    state = await busy()
    if (state === null) return { idle: false, waitedMs: now() - startedAt, unknown: true }
  }
  const waitedMs = now() - startedAt
  return { idle: state !== true, waitedMs, unknown: false }
}
