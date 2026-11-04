#!/usr/bin/env node
/**
 * Minimal cookie-authenticated DSH host API driver for the herdr-status
 * end-to-end probe.
 *
 * The host fences `/api/*` behind a signed browser-session cookie. The launch
 * token is printed on the host's stdout as `dsh web: http://127.0.0.1:<port>/?token=<token>`;
 * a GET of that exact root URL answers 303 with `Set-Cookie`, which every later
 * `/api/<method>` POST must send.
 *
 * Wire envelope (verified against dsh 0.2.2-rc.1 `dsh-client-connection`):
 *   request  { type: 'client-request', rpcId, method, payload: { args } }
 *   response { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * Endpoint names are `<namespace>/<method>` (verified: `session/create`,
 * `session/prompt`, `session/cancel`).
 *
 * Usage:
 *   node drive.mjs --token <token> [--base-url http://127.0.0.1:3181]
 *                  [--cwd /tmp/probe] [--prompt "hello"] [--mode simple|blocked]
 *                  [--state-file ~/.local/state/dsh-herdr/agents.json]
 *                  [--hold-ms 3000] [--timeout-ms 90000]
 *
 * Output: one JSON line per phase transition on stdout (`phase`, `ts`, `state`,
 * `sessionId`, `record`), so the caller can tee it as evidence.
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Parse `--key value` / `--key=value` CLI flags. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq !== -1) {
      out[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[item.slice(2)] = next
      index += 1
    } else {
      out[item.slice(2)] = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const baseUrl = String(args['base-url'] ?? process.env.DSH_PROBE_URL ?? 'http://127.0.0.1:3181').replace(/\/+$/u, '')
const token = String(args.token ?? process.env.DSH_PROBE_TOKEN ?? '')
const cwd = String(args.cwd ?? process.env.DSH_PROBE_CWD ?? process.cwd())
const prompt = String(args.prompt ?? 'report status')
const mode = String(args.mode ?? 'simple')
const stateFile = String(args['state-file'] ?? process.env.DSH_HERDR_STATE ?? join(homedir(), '.local', 'state', 'dsh-herdr', 'agents.json'))
const holdMs = Number(args['hold-ms'] ?? 3000)
const timeoutMs = Number(args['timeout-ms'] ?? 120_000)
const pollMs = 100

if (token === '') {
  console.error('drive: --token (or DSH_PROBE_TOKEN) is required; read it from the host stdout line "dsh web: http://127.0.0.1:<port>/?token=..."')
  process.exit(2)
}

/** Emit one evidence line. */
function phase(name, detail = {}) {
  process.stdout.write(`${JSON.stringify({ phase: name, ts: Date.now(), ...detail })}\n`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── auth ─────────────────────────────────────────────────────────────────────

const authResponse = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const setCookie = authResponse.headers.getSetCookie?.()?.[0] ?? authResponse.headers.get('set-cookie')
if (setCookie === undefined || setCookie === '') {
  console.error(`drive: token exchange failed: HTTP ${authResponse.status} without Set-Cookie`)
  process.exit(3)
}
const cookie = setCookie.split(';', 1)[0]
phase('authenticated', { status: authResponse.status, cookieName: cookie.split('=', 1)[0] })

/** One unary DSH Remote RPC: POST /api/<namespace>/<method> with `{ args }`. */
async function rpc(method, args = {}) {
  const rpcId = `probe-${randomUUID()}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${text.slice(0, 300)}`)
  let message
  try {
    message = JSON.parse(text)
  } catch {
    throw new Error(`${method}: response is not JSON: ${text.slice(0, 300)}`)
  }
  if (message.type !== 'server-response' || message.rpcId !== rpcId) throw new Error(`${method}: bad envelope`)
  if (message.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(message.result?.error ?? message.result)}`)
  return message.result.value
}

// ── state observation ────────────────────────────────────────────────────────

/** Read the shared state document; tolerate the writer replacing it. */
function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return undefined
  }
}

/** Find one session record in the shared state document. */
function findSession(document, sessionId) {
  return document?.sessions?.find?.(entry => entry.id === sessionId)
}

/** Poll until `predicate(record, document)` is truthy or the deadline expires. */
async function waitFor(label, predicate) {
  const deadline = Date.now() + timeoutMs
  let lastSignature
  while (Date.now() < deadline) {
    const document = readState()
    const record = findSession(document, sessionId)
    const signature = JSON.stringify([record?.status, record?.activity, record?.lastTurnEndMs])
    if (signature !== lastSignature) {
      lastSignature = signature
      phase(`${label}:observed`, {
        sessionId,
        state: record?.status ?? null,
        activity: record?.activity ?? null,
        aggregate: document?.aggregate ?? null,
        updatedMs: document?.updatedMs ?? null,
      })
    }
    if (predicate(record, document)) return record
    await sleep(pollMs)
  }
  throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
}

// ── scenario ─────────────────────────────────────────────────────────────────

const created = await rpc('session/create', { request: { cwd, agentPreset: 'standard' } })
const sessionId = created.sessionId
phase('session-created', { sessionId, cwd, agentPreset: created.agentPreset ?? 'standard' })

phase('prompt', { sessionId, prompt, mode })
await rpc('session/prompt', { request: { requestId: `probe-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] } })

if (mode === 'blocked') {
  await waitFor('blocked', record => record?.status === 'blocked')
  phase('blocked-captured', { sessionId, holdMs })
  await sleep(holdMs)
  phase('cancel', { sessionId })
  await rpc('session/cancel', { request: { sessionId } })
  await waitFor('idle-after-cancel', record => record?.status === 'idle' && record?.lastTurnEndMs !== null)
} else {
  await waitFor('turn', record => record?.status === 'idle' && record?.lastTurnEndMs !== null)
}

phase('done', { sessionId })
