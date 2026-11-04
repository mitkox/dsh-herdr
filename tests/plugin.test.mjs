import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../plugin/index.js'

function mount(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-test-'))
  const state = path.join(home, 'agents.json')
  const handlers = new Map()
  const cleanups = []
  const session = { id: 'session-fixture', header: { cwd: '/tmp/fixture' } }
  const agent = { session, status: 'running' }
  const ctx = {
    on(name, handler) { handlers.set(name, handler) },
    effect(fn) { cleanups.push(fn()) },
    get(name) { return name === 'agents' ? { list: () => [agent] } : undefined },
    inject(_names, fn) { fn() },
  }
  apply(ctx, { stateFile: state, osc: false, debounceMs: 0, ...config })
  const dispose = () => cleanups.forEach((fn) => fn?.())
  t.after(() => { dispose(); fs.rmSync(home, { recursive: true, force: true }) })
  const emit = (type, data = {}) => handlers.get('session/event')?.(session, { type, data })
  const read = () => JSON.parse(fs.readFileSync(state, 'utf8'))
  const waitFor = async (status) => {
    const deadline = Date.now() + 1500
    while (read().sessions[0]?.status !== status) {
      assert.ok(Date.now() < deadline, `plugin did not publish ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return read()
  }
  return { state, emit, read, waitFor, dispose, handlers, agent }
}

test('native questions resolve during the same turn for DSH result ID shapes', async (t) => {
  const plugin = mount(t)
  for (const result of [
    { message: { toolCallId: 'q' } },
    { message: { source: { callId: 'q' } } },
    { toolCallId: 'q' }, { callId: 'q' },
  ]) {
    plugin.emit('tool/call', { callId: 'q', name: 'ask_user_question', arguments: '{"questions":[{"question":"Choose a branch"}]}' })
    const before = await plugin.waitFor('blocked')
    plugin.emit('tool/result', result)
    const after = await plugin.waitFor('working')
    assert.ok(after.updatedMs >= before.updatedMs)
    assert.equal(after.sessions[0].blockedReason, undefined)
    assert.equal(after.sessions[0].activity, 'thinking')
  }
  plugin.emit('tool/call', { callId: 'q', name: 'exit_plan_mode', arguments: '{"plan":"Ship it"}' })
  await plugin.waitFor('blocked')
  plugin.emit('tool/result', { message: { toolCallId: 'q' } })
  await plugin.waitFor('working')
})

test('native permission decisions publish promptly and disposal cancels pending flushes', async (t) => {
  const plugin = mount(t, { debug: true })
  plugin.emit('approval/asked', { id: 'a', toolName: 'bash' })
  const blocked = await plugin.waitFor('blocked')
  assert.equal(blocked.sessions[0].blockedReason, 'permission')
  plugin.emit('approval/decided', { id: 'a', outcome: 'allowed-once' })
  await plugin.waitFor('working')
  assert.equal(fs.statSync(plugin.state).mode & 0o777, 0o600)
  const debug = path.join(path.dirname(plugin.state), 'herdr-debug.jsonl')
  assert.equal(fs.statSync(debug).mode & 0o777, 0o600)
  fs.chmodSync(debug, 0o644)
  plugin.handlers.get('agent/status')({ agent: plugin.agent, status: 'running' })
  assert.equal(fs.statSync(debug).mode & 0o777, 0o600)
  const before = fs.readFileSync(plugin.state, 'utf8')
  plugin.emit('tool/call', { callId: 'late', name: 'ask_user_question' })
  plugin.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fs.readFileSync(plugin.state, 'utf8'), before)
  plugin.emit('turn/end')
  assert.equal(fs.readFileSync(plugin.state, 'utf8'), before)
})

test('disabled plugin does not subscribe or write state', (t) => {
  const plugin = mount(t, { enabled: false })
  assert.equal(plugin.handlers.size, 0)
  assert.equal(fs.existsSync(plugin.state), false)
})
