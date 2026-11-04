/**
 * herdr-status — a DeepSeek Harness host plugin that makes this host visible as
 * an agent inside Herdr (`herdr-core` + `herdr-app`).
 *
 * Two independent outputs, both failure-isolated from the host:
 *
 * 1. OSC 7501 status records on the host's terminal (only when the host runs in
 *    a Herdr-managed terminal: `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` are set
 *    and stdout is a TTY). Records are `ESC ] 7501 ; k=v(:k=v)* ESC \` with
 *    `app=dsh-tui`, `state=idle|working|blocked|done`, `kind=permission|question`
 *    (blocked only), and base64-encoded `title`/`msg` (Herdr decodes them;
 *    limits: title ≤ 192 bytes, msg ≤ 2048 bytes decoded).
 *
 * 2. An atomically replaced JSON state document (default
 *    `<repo>/state/dsh-agents.json`) describing every live session, for a
 *    Herdr app monitor mod to poll. Schema: STATE-SCHEMA.md.
 *
 * The plugin never throws or blocks on a failure path: every terminal write,
 * filesystem write, timer and event handler is contained, and a host reload
 * (dispose) flushes and removes its timers.
 *
 * @module dsh-plugin-herdr
 */

import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'herdr-status'

/** `app` field reported to Herdr: resolves to the built-in "DeepSeek Harness" name + icon. */
const DEFAULT_APP = 'dsh-tui'
/** Identity written into the shared state document (`producer`). */
const PRODUCER = 'dsh-plugin-herdr'
/** Idle wording shared with the attach-mode producer so mods can treat activity as a string. */
const IDLE_ACTIVITY = 'waiting for activity…'
/** Herdr `title` limit is 192 decoded bytes; keep UI-friendly headroom. */
const MAX_TITLE_CHARS = 120
const MAX_TITLE_BYTES = 180
/** Herdr `msg` limit is 2048 decoded bytes; activity lines are much shorter. */
const MAX_MSG_CHARS = 200
const MAX_MSG_BYTES = 600
/** Reported `app` must be at most 32 bytes from the Herdr name set. */
const MAX_APP_BYTES = 32
/** Grace period a disposed session stays visible as `done` in the state document. */
const DONE_TTL_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_DEBOUNCE_MS = 100
/** How far back a resumed session's log is scanned for its last `session/title`. */
const TITLE_SCAN_EVENTS = 4_000

/** Read the first non-empty trimmed environment value. */
function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Resolve the byte sink for OSC reports: stdout when it is the terminal, else
 * the process's controlling terminal (`/dev/tty`) opened once. Writes to a
 * captured (piped) stdout would corrupt logs and never reach Herdr, so the
 * controlling TTY is the correct channel in that case.
 * @param {boolean} stdoutIsTty - whether process.stdout is the terminal.
 * @returns {((payload: string) => void)|undefined} a write function, or
 *   undefined when no terminal is available.
 */
function resolveTtySink(stdoutIsTty) {
  if (stdoutIsTty) {
    return payload => process.stdout.write(payload)
  }
  try {
    // `w` on the controlling terminal only; kept open for the plugin lifetime.
    const fd = openSync('/dev/tty', 'w')
    const sink = payload => writeSync(fd, payload)
    sink.close = () => closeSync(fd)
    return sink
  } catch {
    return undefined
  }
}

/** Resolve the Harness home used as the fallback state location. */
function defaultDshHome() {
  const configured = envValue('DSH_HOME')
  return configured === undefined ? join(homedir(), '.dsh') : configured
}

/**
 * Canonical state document every DSH -> Herdr producer writes and the Herdr app
 * mod reads: `~/.local/state/dsh-herdr/agents.json` (`$XDG_STATE_HOME` is not
 * consulted; `DSH_HERDR_STATE` overrides the full file path).
 */
function defaultStateFile() {
  return join(homedir(), '.local', 'state', 'dsh-herdr', 'agents.json')
}

/** Normalize a configured path; relative paths resolve against the host's cwd. */
function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

/**
 * Validate and freeze the plugin configuration. Unknown or malformed values
 * fall back to defaults instead of failing the host boot.
 * @param {unknown} config - raw loader row config.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const stateFileValue = typeof raw.stateFile === 'string' && raw.stateFile.trim() !== ''
    ? resolvePath(raw.stateFile.trim())
    : undefined
  const debugValue = raw.debug === true || envValue('DSH_HERDR_DEBUG') !== undefined
  const heartbeatMs = Number.isSafeInteger(raw.heartbeatMs) && raw.heartbeatMs >= 1_000
    ? raw.heartbeatMs
    : DEFAULT_HEARTBEAT_MS
  const debounceMs = Number.isSafeInteger(raw.debounceMs) && raw.debounceMs >= 0
    ? raw.debounceMs
    : DEFAULT_DEBOUNCE_MS
  return Object.freeze({
    enabled: raw.enabled !== false && envValue('DSH_HERDR_DISABLE') !== '1',
    osc: raw.osc !== false,
    app: typeof raw.app === 'string' && raw.app.trim() !== '' ? raw.app.trim() : DEFAULT_APP,
    stateFile: stateFileValue ?? envValue('DSH_HERDR_STATE', 'DSH_PLUGIN_STATE_FILE') ?? defaultStateFile(),
    stateFallbackFile: join(defaultDshHome(), 'state', 'herdr', 'agents.json'),
    debug: debugValue,
    heartbeatMs,
    debounceMs,
    doneTtlMs: DONE_TTL_MS,
  })
}

/** Remove control characters Herdr rejects, collapse whitespace, and bound by chars then bytes. */
function cleanText(value, maxChars, maxBytes) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- deliberate removal of C0/C1 controls.
  let text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
  text = text.replace(/\s+/gu, ' ').trim()
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd()
  while (Buffer.byteLength(text, 'utf8') > maxBytes && text.length > 0) {
    text = text.slice(0, -1).trimEnd()
  }
  return text
}

/** Base64-encode UTF-8 text the way Herdr expects `title`/`msg` values. */
function encodeValue(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** Serialize one OSC 7501 report. `undefined`/`''` fields are omitted. */
function encodeOsc(fields) {
  const parts = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${value}`)
  }
  return `\x1b]7501;${parts.join(':')}\x1b\\`
}

/** A session-id prefix safe to show when no title exists yet. */
function shortId(id) {
  const text = String(id ?? '')
  return text.length > 12 ? `${text.slice(0, 8)}…` : text
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} [config] - loader row config.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  if (!options.enabled) return

  const herdrTerminalId = envValue('HC_TERMINAL_ID') ?? ''
  const herdrSocket = envValue('HC_TERMINAL_SOCKET') ?? ''
  const herdrDetected = herdrTerminalId !== '' || herdrSocket !== ''
  const stdoutIsTty = process.stdout?.isTTY === true
  // The terminal Herdr watches is the host's controlling TTY. Prefer stdout
  // (the normal case); when a launcher captures stdout through a pipe
  // (`dsh ... | tee log`), still report through /dev/tty so OSC never lands in
  // the captured log and Herdr still receives it.
  const ttySink = options.osc && herdrDetected ? resolveTtySink(stdoutIsTty) : undefined
  const ttyPath = stdoutIsTty ? '/dev/stdout (tty)' : (ttySink !== undefined ? '/dev/tty' : null)
  const oscEnabled = options.osc && herdrDetected && ttySink !== undefined

  /** @type {Map<string, SessionRecord>} */
  const sessions = new Map()
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set()

  let disposed = false
  let flushTimer
  let heartbeatTimer
  let reportedOsc
  let lastStateFileError
  let lastErrorLogMs = 0
  let writeCount = 0

  /** Report a contained failure at most once every 30s so a broken sink cannot spam the host log. */
  function reportError(scope, error) {
    const now = Date.now()
    if (now - lastErrorLogMs < 30_000) return
    lastErrorLogMs = now
    try {
      process.stderr.write(`herdr-status: ${scope}: ${error instanceof Error ? error.message : String(error)}\n`)
    } catch {
      /* stderr closed — nothing safe left to do */
    }
  }

  /** Append a debug line when tracing is enabled. Never throws. */
  function trace(kind, detail) {
    if (!options.debug) return
    try {
      const dir = dirname(options.stateFile)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'herdr-debug.jsonl')
      appendFileSync(file, '', { mode: 0o600 })
      chmodSync(file, 0o600)
      appendFileSync(file, `${JSON.stringify({ ts: Date.now(), pid: process.pid, kind, ...detail })}\n`)
    } catch (error) {
      reportError('debug trace', error)
    }
  }

  function schedule(fn, delayMs) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try {
        fn()
      } catch (error) {
        reportError('timer', error)
      }
    }, delayMs)
    timer.unref?.()
    timers.add(timer)
    return timer
  }

  function cancel(timer) {
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(timer)
  }

  function touch(record, patch) {
    const now = Date.now()
    let changed = false
    for (const [key, value] of Object.entries(patch)) {
      if (record[key] !== value) {
        record[key] = value
        changed = true
      }
    }
    if (changed) {
      record.updatedMs = now
      scheduleFlush()
    }
    return changed
  }

  /** Create the tracking record for a session if it does not exist yet. */
  function ensureRecord(session, agent) {
    const id = String(session?.id ?? agent?.session?.id ?? '')
    if (id === '') return undefined
    let record = sessions.get(id)
    if (record === undefined) {
      record = {
        id,
        title: '',
        status: 'idle',
        activity: null,
        parentSessionId: readParentSessionId(session ?? agent?.session),
        cwd: readSessionCwd(session ?? agent?.session),
        preset: readSessionPreset(session ?? agent?.session, agent),
        turn: 0,
        lastTurnEndMs: null,
        updatedMs: Date.now(),
        doneUntil: 0,
        pendingApprovals: new Map(),
        pendingQuestions: new Map(),
        tool: null,
      }
      sessions.set(id, record)
      const title = readSessionTitle(session ?? agent?.session)
      if (title !== '') record.title = title
      scheduleFlush()
      trace('session-add', { sessionId: id, title: record.title })
    }
    if (agent !== undefined && record.agent !== agent) record.agent = agent
    return record
  }

  function readParentSessionId(session) {
    try {
      const parent = session?.header?.parentSession
      return parent === undefined ? undefined : String(parent)
    } catch {
      return undefined
    }
  }

  function readSessionPreset(session, agent) {
    try {
      const configured = session?.header?.agentPreset ?? agent?.options?.agentPreset
      return typeof configured === 'string' && configured !== '' ? configured : null
    } catch {
      return null
    }
  }

  function readSessionCwd(session) {
    try {
      const cwd = session?.header?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    } catch {
      return undefined
    }
  }

  /** Nesting depth of a tracked session (0 root, 1 direct subagent, ...). */
  function sessionDepth(record) {
    let depth = 0
    let cursor = record
    const seen = new Set()
    while (cursor?.parentSessionId !== undefined && depth < 8) {
      if (seen.has(cursor.id)) break
      seen.add(cursor.id)
      cursor = sessions.get(cursor.parentSessionId)
      depth += 1
      if (cursor === undefined) break
    }
    return depth
  }

  /**
   * Resolve a session title: the owning service when composed, else a bounded
   * backwards scan of the durable log for the last `session/title` event.
   */
  function readSessionTitle(session) {
    if (session === undefined || session === null) return ''
    const service = safeGet('sessionTitle')
    if (service !== undefined && typeof service.get === 'function') {
      try {
        const snapshot = service.get(session)
        if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string') {
          return cleanText(snapshot.title, MAX_TITLE_CHARS, MAX_TITLE_BYTES)
        }
      } catch {
        /* fall through to the log scan */
      }
    }
    try {
      const seq = typeof session.seq === 'number' ? session.seq : 0
      const stop = Math.max(0, seq - TITLE_SCAN_EVENTS)
      for (let index = seq - 1; index >= stop; index -= 1) {
        const event = typeof session.eventAt === 'function' ? session.eventAt(index) : undefined
        if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
          return cleanText(event.data.title, MAX_TITLE_CHARS, MAX_TITLE_BYTES)
        }
      }
    } catch {
      /* no title available */
    }
    return ''
  }

  /** Optional service lookup that tolerates a composition without that service. */
  function safeGet(serviceName) {
    try {
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  /** Async plugin-time enumeration so a host that mounts this plugin late (HMR) starts populated. */
  function adoptExistingAgents() {
    try {
      const agents = safeGet('agents')
      if (agents === undefined || typeof agents.list !== 'function') return
      const live = agents.list()
      if (!Array.isArray(live)) return
      for (const agent of live) {
        try {
          const record = ensureRecord(agent.session, agent)
          if (record !== undefined && agent.status === 'running') {
            touch(record, { status: 'working', activity: record.activity ?? 'thinking' })
          }
        } catch (error) {
          reportError('adopt agent', error)
        }
      }
    } catch (error) {
      reportError('enumerate agents', error)
    }
  }

  // ── OSC 7501 reporting ────────────────────────────────────────────────────

  /** Pick the report for the current aggregate state: blocked > working > idle. */
  function aggregateReport() {
    const records = [...sessions.values()].filter(record => record.status !== 'done')
    const rootRecords = records.filter(record => record.parentSessionId === undefined)
    const pool = rootRecords.length > 0 ? rootRecords : records
    const byUpdated = (a, b) => b.updatedMs - a.updatedMs

    const blocked = records.filter(record => record.status === 'blocked').sort(byUpdated)
    const working = records.filter(record => record.status === 'working').sort(byUpdated)

    /** @param {SessionRecord} record */
    const sessionTitle = record => record.title !== '' ? record.title : shortId(record.id)

    if (blocked.length > 0) {
      const record = blocked[0]
      const kind = record.blockedReason === 'question' ? 'question' : 'permission'
      return { state: 'blocked', kind, title: sessionTitle(record), msg: record.activity ?? '' }
    }
    if (working.length > 0) {
      const record = working[0]
      return { state: 'working', title: sessionTitle(record), msg: record.activity ?? 'working' }
    }
    const newest = pool.sort(byUpdated)[0] ?? records.sort(byUpdated)[0]
    if (newest === undefined) return { state: 'idle', title: '', msg: '' }
    return { state: 'idle', title: sessionTitle(newest), msg: '' }
  }

  /** Write the current report if it changed (or force it) as one raw OSC sequence. */
  function emitOsc(force = false) {
    if (!oscEnabled || disposed) return
    try {
      const report = aggregateReport()
      const app = cleanText(options.app, MAX_APP_BYTES, MAX_APP_BYTES)
      const fields = {
        state: report.state,
        kind: report.kind,
        app,
        title: report.title === '' ? undefined : encodeValue(report.title),
        msg: report.msg === '' ? undefined : encodeValue(cleanText(report.msg, MAX_MSG_CHARS, MAX_MSG_BYTES)),
      }
      const payload = encodeOsc(fields)
      if (!force && payload === reportedOsc) return
      reportedOsc = payload
      ttySink(payload)
      trace('osc', { payload: payload.replaceAll('\x1b', '\\e'), state: report.state, title: report.title, msg: report.msg })
    } catch (error) {
      reportError('OSC write', error)
    }
  }

  // ── state document ────────────────────────────────────────────────────────

  /** Build the JSON-serializable state document (see STATE-SCHEMA.md). */
  function buildDocument() {
    const now = Date.now()
    const priority = { blocked: 0, working: 1, idle: 2, done: 3 }
    const list = [...sessions.values()]
      .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || b.updatedMs - a.updatedMs)
      .map(record => {
        /** @type {Record<string, unknown>} */
        const entry = {
          id: record.id,
          title: record.title !== '' ? record.title : record.id,
          cwd: record.cwd ?? '',
          preset: record.preset ?? '',
          depth: sessionDepth(record),
          status: record.status,
          activity: record.activity ?? (record.status === 'idle' ? IDLE_ACTIVITY : null),
          turn: record.turn,
          updatedMs: record.updatedMs,
          lastTurnEndMs: record.lastTurnEndMs,
        }
        if (record.status === 'blocked' && record.blockedReason !== undefined) entry.blockedReason = record.blockedReason
        if (record.parentSessionId !== undefined) entry.parentSessionId = record.parentSessionId
        return entry
      })
    const report = aggregateReport()
    return {
      version: 1,
      schemaVersion: 1,
      updatedMs: now,
      producer: PRODUCER,
      mode: 'plugin',
      pane: herdrTerminalId !== '' ? herdrTerminalId : null,
      hostPid: process.pid,
      tty: ttyPath,
      host: {
        url: readWebUrl(),
        pid: process.pid,
        terminalId: herdrTerminalId !== '' ? herdrTerminalId : null,
        herdr: herdrDetected,
        profile: readProfileName(),
        osc: oscEnabled,
        startedMs: startedMs,
      },
      aggregate: {
        state: report.state,
        title: report.title !== '' ? report.title : null,
        msg: report.msg !== '' ? report.msg : null,
        working: list.filter(entry => entry.status === 'working' || entry.status === 'blocked').length,
      },
      sessions: list,
    }
  }

  /** Harness profile name from the loader's profileContext service, else the launcher env. */
  function readProfileName() {
    try {
      const profileContext = safeGet('profileContext')
      const name = profileContext?.name
      if (typeof name === 'string' && name !== '') return name
    } catch {
      /* not a profile boot */
    }
    return envValue('DSH_PROFILE') ?? null
  }

  function readWebUrl() {
    try {
      const webApp = safeGet('webApp')
      if (webApp !== undefined && typeof webApp.getAdvertisedUrl === 'function') {
        const url = webApp.getAdvertisedUrl()
        if (typeof url === 'string' && url !== '') return url
      }
    } catch {
      /* not a web composition */
    }
    return envValue('DSH_WEB_URL') ?? 'http://127.0.0.1:3080'
  }

  /** Atomically replace the state document. Falls back to the Harness home when the primary path is unwritable. */
  function writeStateDocument() {
    if (disposed) return
    let target = options.stateFile
    try {
      const document = buildDocument()
      writeAtomically(target, document)
      lastStateFileError = undefined
      writeCount += 1
      return
    } catch (error) {
      lastStateFileError = error
    }
    // Fallback suppresses repeated primary failures: switch target for this run.
    const fallback = options.stateFallbackFile
    if (fallback !== target) {
      try {
        const document = buildDocument()
        writeAtomically(fallback, document)
        writeCount += 1
        reportError(`state file ${target} (using fallback ${fallback})`, lastStateFileError)
        return
      } catch (error) {
        reportError('state file', error)
        return
      }
    }
    reportError('state file', lastStateFileError)
  }

  function writeAtomically(target, document) {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${writeCount}.tmp`
    const body = `${JSON.stringify(document, null, 2)}\n`
    try {
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, target)
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {
        /* best effort */
      }
      throw error
    }
  }

  // ── event sources ─────────────────────────────────────────────────────────

  /** Coalesce bursts of lifecycle events into one OSC report + one state write. */
  function scheduleFlush() {
    if (disposed || flushTimer !== undefined) return
    flushTimer = schedule(() => {
      flushTimer = undefined
      if (disposed) return
      try {
        emitOsc()
        writeStateDocument()
      } catch (error) {
        reportError('flush', error)
      }
    }, options.debounceMs)
  }

  /** Compute blocked status and activity from the pending maps. */
  function refreshStatus(record) {
    const approval = record.pendingApprovals.values().next()
    if (!approval.done) {
      record.status = 'blocked'
      record.blockedReason = 'permission'
      record.activity = `approval: ${approval.value ?? 'tool'}`
      return
    }
    const question = record.pendingQuestions.values().next()
    if (!question.done) {
      record.status = 'blocked'
      record.blockedReason = 'question'
      record.activity = question.value ?? 'waiting for your answer'
      return
    }
    record.blockedReason = undefined
    if (record.agent !== undefined && record.agent.status === 'running') {
      record.status = 'working'
      if (record.activity === null || record.activity.startsWith('approval') || record.activity === 'waiting for your answer') {
        record.activity = 'thinking'
      }
    } else if (record.status !== 'done') {
      record.status = 'idle'
      record.activity = IDLE_ACTIVITY
    }
  }

  /** Extract a short activity hint from a tool call's arguments (best effort). */
  function toolActivity(toolName, argumentsText) {
    const name = typeof toolName === 'string' ? toolName : 'tool'
    if (argumentsText === undefined || argumentsText === null) return `running ${name}`
    if (name !== 'bash' && name !== 'pwsh' && name !== 'run_code' && name !== 'write' && name !== 'edit') {
      return `running ${name}`
    }
    let args
    try {
      if (typeof argumentsText !== 'string' || argumentsText.length > 16_384) return `running ${name}`
      args = JSON.parse(argumentsText)
    } catch {
      return `running ${name}`
    }
    const hint = name === 'bash' || name === 'pwsh'
      ? args?.command
      : args?.file_path ?? args?.path
    const text = cleanText(typeof hint === 'string' ? hint : '', 60, 180)
    return text === '' ? `running ${name}` : `running ${name}: ${text}`
  }

  function onSessionEvent(session, event) {
    try {
      if (disposed) return
      const record = ensureRecord(session)
      if (record === undefined) return
      switch (event?.type) {
        case 'session/title': {
          touch(record, { title: cleanText(event.data?.title, MAX_TITLE_CHARS, MAX_TITLE_BYTES) })
          return
        }
        case 'turn/start': {
          touch(record, { turn: typeof event.data?.turn === 'number' ? event.data.turn : record.turn })
          if (record.status !== 'blocked') touch(record, { status: 'working', activity: 'thinking' })
          return
        }
        case 'step/start': {
          if (record.status !== 'blocked') touch(record, { activity: 'thinking' })
          return
        }
        case 'assistant/message':
        case 'assistant/attempt':
        case 'user/message': {
          if (record.status === 'blocked') return
          touch(record, { activity: 'thinking' })
          return
        }
        case 'tool/call': {
          const callId = String(event.data?.callId ?? '')
          const toolName = event.data?.name
          if (toolName === 'ask_user_question' || toolName === 'exit_plan_mode') {
            const hint = questionHint(event.data?.arguments)
            record.pendingQuestions.set(callId, hint)
            touch(record, { status: 'blocked', activity: hint, blockedReason: 'question' })
            return
          }
          record.tool = { callId, name: toolName }
          if (record.status !== 'blocked') touch(record, { activity: toolActivity(toolName, event.data?.arguments) })
          return
        }
        case 'tool/result': {
          const callId = String(event.data?.message?.toolCallId
            ?? event.data?.message?.source?.callId
            ?? event.data?.toolCallId ?? event.data?.callId ?? '')
          if (record.pendingQuestions.delete(callId)) {
            record.activity = null
            refreshStatus(record)
            record.updatedMs = Date.now()
            scheduleFlush()
            return
          }
          if (record.tool?.callId === callId) record.tool = null
          if (record.status !== 'blocked') touch(record, { activity: 'thinking' })
          return
        }
        case 'approval/asked': {
          const id = String(event.data?.id ?? '')
          const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName : 'tool'
          record.pendingApprovals.set(id, toolName)
          touch(record, { status: 'blocked', activity: `approval: ${toolName}`, blockedReason: 'permission' })
          return
        }
        case 'approval/decided': {
          const id = String(event.data?.id ?? '')
          if (record.pendingApprovals.delete(id)) {
            refreshStatus(record)
            record.updatedMs = Date.now()
            scheduleFlush()
          }
          return
        }
        case 'turn/end': {
          touch(record, { lastTurnEndMs: Date.now() })
          record.pendingQuestions.clear()
          if (record.pendingApprovals.size === 0) {
            touch(record, { status: 'idle', activity: IDLE_ACTIVITY, blockedReason: undefined })
          } else {
            refreshStatus(record)
            touch(record, {})
          }
          return
        }
        default:
          return
      }
    } catch (error) {
      reportError(`session event ${String(event?.type)}`, error)
    }
  }

  function questionHint(argumentsText) {
    try {
      if (typeof argumentsText !== 'string') return 'waiting for your answer'
      const args = JSON.parse(argumentsText)
      const text = args?.questions?.[0]?.question ?? args?.questions?.[0]?.header
      const hint = cleanText(typeof text === 'string' ? text : '', 80, 240)
      return hint === '' ? 'waiting for your answer' : hint
    } catch {
      return 'waiting for your answer'
    }
  }

  function onAgentCreated(payload) {
    try {
      if (disposed) return
      const agent = payload?.agent
      if (agent === undefined) return
      const record = ensureRecord(agent.session, agent)
      if (record === undefined) return
      if (record.status !== 'blocked') {
        touch(record, {
          status: agent.status === 'running' ? 'working' : 'idle',
          activity: agent.status === 'running' ? record.activity ?? 'thinking' : null,
        })
      }
      trace('agent-created', { sessionId: record.id, source: payload?.source, status: agent.status })
    } catch (error) {
      reportError('agent/created', error)
    }
  }

  function onAgentStatus(payload) {
    try {
      if (disposed) return
      const agent = payload?.agent
      if (agent === undefined) return
      const record = ensureRecord(agent.session, agent)
      if (record === undefined) return
      if (record.status === 'blocked') {
        touch(record, {})
        return
      }
      if (payload.status === 'running') {
        touch(record, { status: 'working', activity: record.activity ?? 'thinking' })
      } else {
        record.pendingApprovals.clear()
        record.pendingQuestions.clear()
        touch(record, { status: 'idle', activity: null, blockedReason: undefined })
      }
      trace('agent-status', { sessionId: record.id, status: payload.status })
    } catch (error) {
      reportError('agent/status', error)
    }
  }

  function onAgentDisposed(payload) {
    try {
      if (disposed) return
      const agent = payload?.agent
      if (agent === undefined) return
      const id = String(agent.session?.id ?? '')
      const record = sessions.get(id)
      if (record === undefined) return
      record.agent = undefined
      record.pendingApprovals.clear()
      record.pendingQuestions.clear()
      record.tool = null
      touch(record, { status: 'done', activity: null, blockedReason: undefined })
      record.doneUntil = Date.now() + options.doneTtlMs
      trace('agent-disposed', { sessionId: id })
      scheduleFlush()
    } catch (error) {
      reportError('agent/disposed', error)
    }
  }

  /** Drop `done` records after their grace period. */
  function pruneDisposedSessions() {
    const now = Date.now()
    let changed = false
    for (const [id, record] of sessions) {
      if (record.status === 'done' && record.doneUntil !== 0 && now >= record.doneUntil) {
        sessions.delete(id)
        changed = true
      }
    }
    if (changed) scheduleFlush()
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  const startedMs = Date.now()

  // Durable lifecycle is observed through session/event and agent/* events; all
  // handlers are contained so a listener failure can never reach the host.
  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/created', onAgentCreated)
  ctx.on('agent/status', onAgentStatus)
  ctx.on('agent/disposed', onAgentDisposed)

  // Optional enumeration for a late mount (HMR / plugin reload).
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agents'], () => adoptExistingAgents())
    } else {
      adoptExistingAgents()
    }
  } catch (error) {
    reportError('inject agents', error)
  }

  // Heartbeat keeps the state document fresh (readers treat >20s staleness as a
  // dead watcher) and re-sends the current OSC record defensively.
  heartbeatTimer = schedule(function heartbeat() {
    if (disposed) return
    try {
      pruneDisposedSessions()
      emitOsc(true)
      writeStateDocument()
    } catch (error) {
      reportError('heartbeat', error)
    }
    heartbeatTimer = schedule(heartbeat, options.heartbeatMs)
  }, options.heartbeatMs)
  heartbeatTimer.unref?.()

  // Initial publication so monitors see a document even before any session exists.
  writeStateDocument()
  emitOsc(true)
  trace('mounted', {
    stateFile: options.stateFile,
    herdr: herdrDetected,
    osc: oscEnabled,
    hcTerminalId: herdrTerminalId,
    hcTerminalSocket: herdrSocket,
    stdoutIsTty,
    ttySink: ttySink !== undefined,
  })

  /** Reverse everything this plugin installed. Idempotent and non-throwing. */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    flushTimer = undefined
    heartbeatTimer = undefined
    try { ttySink?.close?.() } catch { /* terminal already gone */ }
    try {
      writeStateDocument()
      // Leave the state document with an empty session list? No: the host is
      // still exiting; readers distinguish staleness by updatedMs.
      emitOsc(true)
    } catch {
      /* teardown must not throw */
    }
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => dispose())
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => dispose())
    }
  } catch (error) {
    reportError('dispose registration', error)
  }

  trace('apply-done', { writeCount })
}

/** @typedef {ReturnType<typeof resolveConfig>} PluginOptions */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} title
 * @property {'idle'|'working'|'blocked'|'done'} status
 * @property {string|null} activity
 * @property {'permission'|'question'|undefined} [blockedReason]
 * @property {string|undefined} [parentSessionId]
 * @property {number} updatedMs
 * @property {number} doneUntil
 * @property {Map<string, string>} pendingApprovals
 * @property {Map<string, string>} pendingQuestions
 * @property {{callId: string, name: string}|null} tool
 * @property {object|undefined} [agent]
 */
