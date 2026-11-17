/**
 * OpenLess → DSH 语音任务桥：Host 半边。
 *
 * 监听 OpenLess 的 history.json，把新的、有正文的语音转写投递到一个固定
 * DSH 会话；模型识别出任务后调用 openless_task_confirm 弹小窗确认，
 * 确认前由工具守卫拒绝动手类工具。没有任务时不弹窗。
 *
 * @module dsh-openless-task
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createGate, isExemptTool } from './lib/gate.js'
import { pickDefaultSession } from './lib/default-session.js'
import { waitForIdle } from './lib/idle.js'
import { createPopup } from './lib/popup.js'
import { readState, writeState } from './lib/state.js'
import { createWatcher } from './lib/watcher.js'

/** 插件名（Loader 行 id 由 cordis.patch.yml 决定）。 */
export const name = 'openless-task'

/** 硬依赖：工具注册表与 Session 控制器。 */
export const inject = ['tools', 'sessionController']

/** 默认的「动手类」工具：确认前一律拒绝。`*` 结尾表示前缀匹配。 */
export const DEFAULT_ACTING_TOOLS = [
  'run_code',
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'workflow',
  'create_bot',
  'message_bot',
  'send_wechat',
  'remote_ssh_*',
  'terminal*',
  'schedule_*',
  'job_*',
]

/** Windows 上 OpenLess 的默认历史文件位置。 */
function defaultHistoryPath() {
  const appData = process.env.APPDATA
  if (appData) return join(appData, 'OpenLess', 'history.json')
  return join(homedir(), '.openless', 'history.json')
}

/**
 * 建一个同时写控制台和文件（Host 控制台在桌面端不可见）的日志函数。
 * @returns {(...parts: unknown[]) => void} 日志函数。
 */
function createLogger() {
  const dir = join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-openless-task')
  const file = join(dir, 'openless-task.log')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 忽略：只能写控制台
  }
  return (...parts) => {
    try {
      const line = `${new Date().toISOString()} ${parts.map((part) => {
        if (typeof part === 'string') return part
        if (part instanceof Error) return `${part.name}: ${part.message}`
        try {
          return JSON.stringify(part)
        } catch {
          return String(part)
        }
      }).join(' ')}\n`
      const stat = statSync(file, { throwIfNoEntry: false })
      if (stat !== undefined && stat.size > 1000000) writeFileSync(file, '')
      appendFileSync(file, line)
    } catch {
      // 忽略日志失败
    }
    console.log('[dsh-openless-task]', ...parts)
  }
}

/**
 * 读取一个配置字段。`.volatile()` 字段在 schema 验证后是引用对象，需要 `.get()`；
 * 其余字段是普通值。
 * @param {unknown} raw - 原始字段值。
 * @returns {unknown} 实时值。
 */
function readValue(raw) {
  if (raw == null) return raw
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      return undefined
    }
  }
  if (typeof raw === 'object' && raw.meta && raw.meta.volatile === true && 'value' in raw) {
    return raw.value
  }
  return raw
}

/** 配置 schema。 */
export const Config = z.object({
  /** 总开关；关掉后不再接手新的语音条目。 */
  enabled: z.boolean().default(true).volatile(),
  /** OpenLess 的历史文件。 */
  historyPath: z.string().default(defaultHistoryPath()),
  /** 轮询周期（毫秒）；文件事件作为补充。 */
  pollMs: z.number().min(500).max(10000).default(1000),
  /** 固定会话 id；用 openless_bind_here 写入。 */
  sessionId: z.string().default('').volatile(),
  /** 小窗等待上限（毫秒）。 */
  confirmTimeoutMs: z.number().min(60000).max(1800000).default(300000),
  /** 「待确认」旗标最长挂起时间（毫秒），防止会话被永久卡住。 */
  pendingTtlMs: z.number().min(30000).max(600000).default(180000),
  /** 会话正忙时最多等多久再投递（毫秒）；0 = 不等，直接投递且不挂旗标。 */
  idleWaitMs: z.number().min(0).max(600000).default(120000),
  /** 浏览器路径；空 = 自动找 Edge / Chrome。 */
  browserPath: z.string().default(''),
  /** 确认前被守卫拒绝的工具名；`*` 结尾表示前缀。 */
  actingTools: z.array(z.string()).default([...DEFAULT_ACTING_TOOLS]),
  /** 投递到会话的转写最大字符数。 */
  maxPromptChars: z.number().min(200).max(20000).default(4000),
})

/**
 * Host 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {Record<string, unknown>} config - 本行的配置。
 */
export function apply(ctx, config) {
  /** 带前缀的日志（同时写本地日志文件）。 */
  const log = createLogger()

  /** 读取实时配置。 */
  const read = (key) => readValue(config?.[key])

  const popup = createPopup({ read, log })
  const gate = createGate({ read, log })
  /** 插件生命周期信号，随插件卸载中止在途的 Session 请求。 */
  const lifeController = new AbortController()

  /** 当前绑定的会话 id：配置优先，其次上次自动绑定，最后本次自动绑定。 */
  const boundSession = () => String(read('sessionId') ?? '').trim() || storedSession || autoBound
  const enabled = () => read('enabled') !== false

  /** 最近一条投递过的语音原文，供确认工具兜底。 */
  let lastTranscript = ''
  /** 上次启动挑好的会话（状态文件里的）。 */
  let storedSession = String(readState().sessionId ?? '')
  /** 本次启动自动绑定、尚未落盘的会话 id。 */
  let autoBound = ''
  /** 进行中的自动绑定，避免并发重复挑选。 */
  let binding = null
  /** 错误提示的节流时间。 */
  const lastNotice = new Map()

  /**
   * 限流地弹一条提示小窗；没有浏览器时只写日志。
   * @param {string} key - 提示种类，用于节流。
   * @param {string} summary - 标题。
   * @param {string} message - 正文。
   */
  function notice(key, summary, message) {
    const now = Date.now()
    if (now - (lastNotice.get(key) ?? 0) < 60000) return
    lastNotice.set(key, now)
    void popup.show({ kind: 'notice', summary, message }).catch((error) => {
      log('notice failed', error)
    })
  }

  /**
   * 校验绑定会话是否还存在，并取展示用的工作目录。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{ cwd?: string } | null>} 存在时的摘要，否则 null。
   */
  async function lookupSession(sessionId) {
    try {
      const signal = new AbortController().signal
      const page = await ctx.sessionController.list({}, signal)
      const items = Array.isArray(page?.items) ? page.items : []
      return items.find((item) => item.sessionId === sessionId) ?? null
    } catch (error) {
      log('session list failed', error)
      return null
    }
  }

  /**
   * 保存绑定的会话：状态文件为主，插件配置尽力而为（激活期间写配置会被 HMR 拒绝）。
   * @param {string} sessionId - 要保存的会话 id。
   * @returns {Promise<boolean>} 状态文件是否写入成功。
   */
  async function persistSessionId(sessionId) {
    storedSession = sessionId
    const saved = writeState({ sessionId })
    const entry = ctx.fiber?.entry
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
    if (entry && editor && typeof editor.edit === 'function') {
      try {
        await editor.edit(entry, (current) => ({ ...current, sessionId }))
      } catch (error) {
        log('config sessionId not saved (state file is authoritative):', error?.message ?? error)
      }
    }
    return saved
  }

  /**
   * 没有绑定过时，自动挑最近活跃的会话并落盘——安装后即可用，不需要手工绑定。
   * @returns {Promise<string>} 最终使用的会话 id（可能为空）。
   */
  async function ensureBound() {
    const configured = String(read('sessionId') ?? '').trim()
    if (configured) return configured
    if (storedSession) return storedSession
    if (autoBound) return autoBound
    if (binding !== null) return binding
    binding = (async () => {
      try {
        const signal = new AbortController().signal
        const page = await ctx.sessionController.list({}, signal)
        const picked = pickDefaultSession(page?.items)
        if (!picked) {
          log('auto-bind skipped: no usable session')
          return ''
        }
        autoBound = picked
        const saved = writeState({ sessionId: picked })
        log('auto-bound to', picked, saved ? '(saved)' : '(memory only)')
        return picked
      } catch (error) {
        log('auto-bind failed', error)
        return ''
      } finally {
        binding = null
      }
    })()
    return binding
  }

  /**
   * 组装投递到会话的文本。
   * @param {string} text - 语音正文。
   * @returns {string} 投递文本。
   */
  function composePrompt(text) {
    const limit = Number(read('maxPromptChars')) || 4000
    const body = text.length > limit ? `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字）` : text
    return [
      '【OpenLess 语音】以下是我刚说的一段话（语音转写，可能有同音错字）：',
      '',
      body,
      '',
      '处理要求：先判断这段话里有哪些要执行的任务，用简短列表列出，然后调用 openless_task_confirm 工具把任务清单交给我确认。',
      '如果这段话里没有可执行的任务，就只在会话里回答，不要调用 openless_task_confirm，也不要弹窗。',
      '在我点「执行」之前不要动手（确认前，改动类工具会被拒绝）。',
      '我点「执行」后再开始；点「忽略」就停下并说明未执行。',
    ].join('\n')
  }

  /**
   * 投递一条新的语音转写到固定会话。
   * @param {{ id: string, finalText: string }} entry - OpenLess 历史条目。
   */
  async function deliver(entry) {
    if (!enabled()) return
    const text = String(entry.finalText ?? '').trim()
    if (!text) return
    const target = await ensureBound()
    if (!target) {
      notice('unbound', '未绑定会话', '找不到可绑定的会话：在目标会话里让我调用 openless_bind_here 绑定一次。')
      return
    }
    const session = await lookupSession(target)
    if (!session) {
      notice('stale', '绑定的会话不存在', `会话 ${target} 已经不在了，请在目标会话里重新运行 openless_bind_here。`)
      return
    }
    lastTranscript = text
    // 只有会话空闲时才挂旗标：忙的时候挂，会把你当前这一轮（还没看到语音的）回合里的
    // run_code / pwsh 一起拒掉，模型于是反复重试，确认卡片永远没人去调。
    const readiness = await waitForIdle({
      isRunning: async () => (await lookupSession(target))?.running === true,
      timeoutMs: Number(read('idleWaitMs')) || 0,
      intervalMs: 1000,
    })
    if (readiness.unknown) {
      log('session busy state unknown; arming the gate anyway')
      gate.arm(target)
    } else if (readiness.idle) {
      if (readiness.waitedMs > 1000) log('waited', readiness.waitedMs, 'ms for an idle session')
      gate.arm(target)
    } else {
      // 等不到空闲就别挂旗标：宁可这条语音少一层拦截，也不把你正在跑的回合锁死。
      log('session stayed busy for', readiness.waitedMs, 'ms; delivering without the confirm gate')
    }
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: target,
        mode: 'queue',
        content: [{ type: 'text', text: composePrompt(text) }],
        ...(timeZone ? { clientTimeZone: timeZone } : {}),
      }, lifeController.signal)
      log('delivered', entry.id, '->', target)
    } catch (error) {
      gate.clear()
      log('prompt failed', error)
      notice('prompt', '投递失败', String(error?.message ?? error))
    }
  }

  const watcher = createWatcher({
    path: () => String(read('historyPath') ?? ''),
    pollMs: () => Number(read('pollMs')) || 1000,
    log,
    onEntry: deliver,
  })

  // ---- 工具：确认 ----
  const confirmTool = defineTool({
    name: 'openless_task_confirm',
    description:
      '把 OpenLess 语音转写里识别出的任务清单交给用户确认，并在用户点「执行」或「忽略」后返回结果。'
      + '用户点「执行」之前不要动手；没有可执行任务时不要调用本工具。'
      + 'Show the user the task list in a small confirmation window and wait for their choice.',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: '一句话说明准备做什么。',
      },
      tasks: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '要做的事，逐条。放在这里让用户确认。',
      },
      transcript: {
        type: 'string',
        description: '对应的语音原文；留空时插件使用最近一条投递的语音。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          choice: { type: 'string', required: true, enum: ['execute', 'ignore', 'timeout', 'skipped'] },
          popup: { type: 'string', required: true, enum: ['shown', 'unavailable', 'skipped'] },
        },
      },
      render: (_args, value) => {
        const text = value.choice === 'execute'
          ? '用户已确认执行。'
          : value.choice === 'ignore'
            ? '用户选择忽略，不要执行。'
            : value.choice === 'timeout'
              ? '等待超时，按未执行处理。'
              : '没有任务清单，未弹窗。'
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const tasks = Array.isArray(args?.tasks)
        ? args.tasks.map((task) => String(task ?? '').trim()).filter(Boolean)
        : []
      if (tasks.length === 0) {
        gate.clear()
        return { choice: 'skipped', popup: 'skipped' }
      }
      const transcript = typeof args?.transcript === 'string' && args.transcript.trim()
        ? args.transcript.trim()
        : lastTranscript
      const summary = String(args?.summary ?? '').trim() || tasks[0]
      const result = await popup.show({
        kind: 'confirm',
        summary,
        tasks,
        transcript,
        sessionId: exec?.agent?.id ?? '',
      })
      gate.clear()
      log('confirm result', result.choice, result.popup)
      return { choice: result.choice, popup: result.popup }
    },
  })

  // ---- 工具：绑定 ----
  const bindTool = defineTool({
    name: 'openless_bind_here',
    description:
      '把 OpenLess 语音任务的目标会话绑定到当前会话，并写入插件配置。'
      + 'Bind the fixed OpenLess task session to the current session so dictated tasks land here.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          saved: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(_args, exec) {
      const sessionId = String(exec?.agent?.id ?? '')
      if (!sessionId) throw new Error('openless_bind_here 需要在一个会话里调用')
      autoBound = sessionId
      const saved = await persistSessionId(sessionId)
      const message = saved
        ? `已把 OpenLess 语音任务绑定到当前会话（${sessionId}）。之后说的话会送到这里。`
        : `已在本进程内绑定 ${sessionId}，但状态文件写不进去；重启后会自动绑定到最近活跃的会话。`
      log('bind', sessionId, saved)
      return { sessionId, saved, message }
    },
  })

  ctx.effect(() => ctx.tools.register(confirmTool))
  ctx.effect(() => ctx.tools.register(bindTool))
  ctx.effect(() => ctx.tools.guard((exec) => {
    const pending = gate.check(exec)
    if (pending && !isExemptTool(exec?.name)) {
      log('gate denied', exec?.name, 'in', exec?.agent?.id)
    }
    return pending
  }))
  ctx.effect(() => watcher.start())
  ctx.effect(() => () => {
    lifeController.abort()
    popup.dispose()
  })

  log('ready; history =', String(read('historyPath') ?? ''), '; session =', boundSession() || '(未绑定)')
  void ensureBound().then((sessionId) => {
    if (sessionId) log('target session =', sessionId)
  })
}
