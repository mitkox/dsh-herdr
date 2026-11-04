import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { promises as realFs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createZstdDecompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { StateFileWriter } from '../monitor/lib/statefile.mjs'
import { SessionJournal } from '../monitor/lib/sessionlog.mjs'
import { eventLine, makeColors } from '../monitor/lib/format.mjs'

const launcher = fileURLToPath(new URL('../bin/dsh-herdr', import.meta.url))
const source = fs.readFileSync(launcher, 'utf8')
const now = Date.now()
const frame = (events) => zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))
const header = { type: 'session', id: 'demo', cwd: '/tmp/demo', delegationDepth: 0 }
const event = (type, seq, data = {}) => ({ type, seq, time: now, data })

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, 'sessions/demo/demo/session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, frame([header, event('turn/start', 0)]))
  return { home, file }
}

// Load the CLI's actual functions without dispatching its process entry point.
// Filesystem and timer boundaries can then be delayed without touching services.
function loadCli(home, overrides = {}) {
  const intervals = []
  const output = []
  const code = source.slice(0, source.indexOf('const entry = command'))
    .replace(/^import .*\n/gm, '')
    .replace('fileURLToPath(import.meta.url)', JSON.stringify(launcher))
  const context = {
    ...fs, fs: realFs, spawn, os, path, Buffer, createZstdDecompress, zstdDecompressSync,
    setTimeout, clearTimeout,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return {} },
    process: {
      argv: [process.execPath, launcher, 'watch', '--quiet', '--no-osc'],
      env: { DSH_HOME: home, XDG_STATE_HOME: home }, pid: process.pid, execPath: process.execPath,
      stdout: { writable: true, write: (text) => output.push(text), on() {} },
      stderr: { write: (text) => output.push(text) }, on() {},
      exit(code) { throw new Error(`unexpected exit ${code}`) },
    },
    ...overrides,
  }
  const api = vm.runInNewContext(code + '\n;({refresh, aggregate, sessions, watchMain, attachMain, daemonMain, captureCommand, pollEvery})', context)
  return { ...api, intervals, output, runtimeProcess: context.process }
}

async function waitFor(check) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for reporter')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a transient journal read failure is retried without another append', async (t) => {
  const { home } = fixture(t)
  let reads = 0
  const cli = loadCli(home, { fs: { ...realFs, async readFile(...args) {
    if (++reads === 1) throw new Error('temporary read failure')
    return realFs.readFile(...args)
  } } })
  await cli.refresh(true)
  await cli.refresh(false)
  assert.equal(reads, 2)
  assert.equal(cli.aggregate().state, 'working')
})

test('watch polling does not overlap a delayed state publication', async (t) => {
  const { home, file } = fixture(t)
  let delay = false
  let writes = 0
  let release
  let started
  const blocked = new Promise((resolve) => { release = resolve })
  const writing = new Promise((resolve) => { started = resolve })
  const cli = loadCli(home, { fs: { ...realFs, async writeFile(...args) {
    if (delay) { writes++; started(); await blocked }
    return realFs.writeFile(...args)
  } } })
  await cli.watchMain()
  fs.appendFileSync(file, frame([event('turn/end', 1)]))
  delay = true
  const first = cli.intervals[0].callback()
  await writing
  const second = cli.intervals[0].callback()
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(writes, 1)
  } finally { release(); await Promise.all([first, second]) }
  const state = JSON.parse(fs.readFileSync(path.join(home, 'dsh-herdr/agents.json'), 'utf8'))
  assert.equal(state.aggregate.state, 'idle')
})

test('a stalled subprocess is killed at its deadline', async (t) => {
  const { home } = fixture(t)
  const cli = loadCli(home)
  const started = Date.now()
  const result = await cli.captureCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 80)
  assert.equal(result, null)
  assert.ok(Date.now() - started < 3000)
})

test('attach makes an existing feed log private and cleans up its pane lock', async (t) => {
  const { home } = fixture(t)
  const log = path.join(home, 'dsh-herdr/attach.log')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, 'existing log\n', { mode: 0o644 })
  const handlers = new Map()
  let exited = false
  const cli = loadCli(home, {
    fs: { ...realFs, readlink: async () => '/dev/null' },
    process: {
      argv: [process.execPath, launcher, 'attach', '--daemon-child', '--host-pid', String(process.pid)],
      env: { DSH_HOME: home, XDG_STATE_HOME: home }, pid: process.pid,
      stdout: { writable: true, write() {}, on() {} }, stderr: { write() {} },
      kill: (pid, signal) => { assert.equal(signal, 0); return process.kill(pid, 0) },
      on: (name, handler) => handlers.set(name, handler), exit: () => { exited = true },
    },
  })
  let failure
  cli.attachMain().catch((error) => { failure = error })
  await waitFor(() => fs.existsSync(path.join(home, 'dsh-herdr/agents.json')) || failure)
  assert.ifError(failure)
  assert.equal(fs.statSync(log).mode & 0o777, 0o600)
  handlers.get('SIGTERM')()
  assert.equal(exited, true)
  assert.equal(fs.readdirSync(path.dirname(log)).filter((name) => name.startsWith('attach-')).length, 0)
})

test('daemon keeps one reporter and replaces it after the host PID changes', async (t) => {
  const { home } = fixture(t)
  const alive = new Set([100, 200])
  const stopped = []
  const attaches = []
  const handlers = new Map()
  let hostPid = 100
  const cli = loadCli(home, { spawn(command, args) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.unref = () => {}
    if (command === 'hc') {
      const document = args[0] === 'ls'
        ? { terminals: [{ address: 't1', state: 'live' }] }
        : { address: 't1', foreground: { pid: hostPid, argv: ['dsh', 'web'] } }
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(document)); child.emit('close', 0) })
    } else {
      assert.equal(command, process.execPath)
      assert.ok(args.includes('attach'))
      child.pid = 500 + attaches.length
      alive.add(child.pid)
      attaches.push(child.pid)
      fs.writeFileSync(path.join(home, 'dsh-herdr/attach-t1.json'), JSON.stringify({ pid: child.pid, hostPid, pane: 't1' }))
    }
    return child
  } })
  cli.runtimeProcess.kill = (pid, signal) => {
    if (!alive.has(pid)) throw new Error('not running')
    if (signal === 'SIGTERM') { stopped.push(pid); alive.delete(pid) }
  }
  cli.runtimeProcess.on = (name, handler) => handlers.set(name, handler)
  let failure
  cli.daemonMain().catch((error) => { failure = error })
  await waitFor(() => cli.intervals.length > 0 || failure)
  assert.ifError(failure)
  const pidFile = path.join(home, 'dsh-herdr/daemon.pid')
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), process.pid)
  const duplicate = loadCli(home)
  duplicate.runtimeProcess.kill = (pid, signal) => {
    assert.equal(signal, 0)
    return process.kill(pid, 0)
  }
  await duplicate.daemonMain()
  assert.equal(duplicate.intervals.length, 0)
  await cli.intervals[0].callback()
  assert.equal(attaches.length, 1)
  hostPid = 200
  await cli.intervals[0].callback()
  assert.equal(attaches.length, 2)
  assert.deepEqual(stopped, [500])
  cli.runtimeProcess.exit = () => {}
  handlers.get('SIGTERM')()
  assert.equal(fs.existsSync(pidFile), false)
})

test('reference journals refresh on append and shorter replacement', async (t) => {
  const { file } = fixture(t)
  fs.appendFileSync(file, frame([event('session/title', 1, { title: 'A long historical title '.repeat(100) }), event('turn/end', 2)]))
  const journal = new SessionJournal(file)
  assert.equal((await journal.refresh()).snapshot.status, 'idle')
  assert.equal((await journal.refresh()).changed, false)
  fs.appendFileSync(file, frame([event('turn/start', 3)]))
  assert.equal((await journal.refresh()).snapshot.status, 'working')
  fs.writeFileSync(file, frame([header, event('session/title', 0, { title: 'Replacement' }), event('turn/end', 1)]))
  const replaced = await journal.refresh()
  assert.equal(replaced.snapshot.title, 'Replacement')
  assert.equal(replaced.snapshot.status, 'idle')
})

test('reference state files are private and idle writes wait for a heartbeat', (t) => {
  const { home } = fixture(t)
  let time = 10000
  const writer = new StateFileWriter({ path: path.join(home, 'state.json'), now: () => time, heartbeatMs: 2500 })
  const rows = [{ id: 'demo', status: 'idle', updatedMs: 1000 }]
  assert.equal(writer.update(rows), true)
  assert.equal(fs.statSync(writer.path).mode & 0o777, 0o600)
  time += 100
  assert.equal(writer.update(rows), false)
  time += 2500
  assert.equal(writer.update(rows), true)
  assert.equal(JSON.parse(fs.readFileSync(writer.path, 'utf8')).updatedMs, time)
  assert.equal(writer.update([{ ...rows[0], status: 'working' }]), true)
})

test('reference feed fields never emit journal terminal controls', () => {
  const payload = '\x1b]52;c;Zm9v\x07\x9b2J'
  const colors = makeColors({ isTTY: false }, {})
  for (const [type, data] of [
    ['session/title', { title: payload }],
    ['tool/call', { name: payload, arguments: JSON.stringify({ command: payload }) }],
    ['tool/call', { name: 'bash', arguments: payload }],
    ['turn/end', { turn: payload, reason: { kind: payload } }],
    ['approval/asked', { toolName: payload, reason: payload }],
    ['approval/decided', { outcome: payload }],
    ['assistant/message', { message: { content: [{ type: 'text', text: payload }] } }],
  ]) {
    assert.doesNotMatch(eventLine({ type, data }, colors), /[\x00-\x1f\x7f-\x9f]/)
  }
})

test('the shipped feed strips controls before adding its own ANSI styling', async (t) => {
  const { home, file } = fixture(t)
  const state = path.join(home, 'live.json')
  const child = spawn(process.execPath, [launcher, 'watch', '--no-osc', '--interval', '120', '--state', state], {
    env: { ...process.env, DSH_HOME: home, HC_TERMINAL_ID: '', HC_TERMINAL_SOCKET: '', HERDR_ENV: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  const stopped = new Promise((resolve) => child.on('close', resolve))
  const waitFor = async (check) => {
    const deadline = Date.now() + 4000
    while (!check()) {
      assert.ok(Date.now() < deadline, 'watcher did not publish in time')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  try {
    await waitFor(() => fs.existsSync(state))
    fs.appendFileSync(file, frame([
      event('session/title', 1, { title: 'unsafe\x1b]52;c;YWJj\x07 title' }),
      event('tool/call', 2, { name: 'custom\x9b2J', arguments: '{}' }),
      event('tool/call', 3, { name: 'read', arguments: JSON.stringify({ file_path: '/tmp/file\x1b]0;path\x07' }) }),
      event('turn/end', 4, { reason: { kind: '\x1b]0;spoof\x07' } }),
    ]))
    await waitFor(() => output.includes('spoof'))
  } finally { child.kill('SIGTERM'); await stopped }
  assert.doesNotMatch(output.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
})
