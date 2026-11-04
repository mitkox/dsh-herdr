import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../app/mods/dsh-monitor/main.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export default class', 'class')
const Panel = vm.runInNewContext(source + '\n;DshMonitor', { View: class {}, home: () => '/tmp/fixture', notify() {} })

test('session updates beat newer producer heartbeats when merging panel data', () => {
  const panel = new Panel()
  panel.notified = new Map()
  panel.lastNotify = 0
  const now = Date.now()
  panel.files = [
    { present: true, updatedMs: now, sessions: [{ id: 'same', title: 'Task', status: 'blocked', updatedMs: now - 2000 }] },
    { present: true, updatedMs: now - 1000, sessions: [{ id: 'same', title: 'Task', status: 'working', updatedMs: now - 1000 }] },
  ]
  panel.merge(now)
  assert.equal(panel.sessions.length, 1)
  assert.equal(panel.sessions[0].status, 'working')
  panel.files[0].sessions[0].updatedMs = now - 1000
  panel.merge(now)
  assert.equal(panel.sessions[0].status, 'blocked', 'document ordering breaks equal session timestamp ties')
})
