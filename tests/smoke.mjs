#!/usr/bin/env node
/**
 * Fixture-based smoke test for the dsh-herdr launcher.
 *
 * Builds a throwaway DSH home with synthetic session journals (the same format
 * the real dsh host writes), runs `dsh-herdr watch --once` against it, and
 * asserts the aggregate/agent state and the state document. Needs no herdr-core,
 * no herdr-app and no dsh installation — only Node's built-in zstd.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = path.join(REPO, 'bin', 'dsh-herdr')
const NOW = Date.now()

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

function journal(header, events, { truncateTail = false } = {}) {
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]
  const encoded = zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
  // A host mid-append leaves a partial trailing zstd frame; the reader must keep
  // the decodable prefix. Two stray bytes are enough to break whole-file decode.
  return truncateTail ? Buffer.concat([encoded, Buffer.from([0x28, 0xb5, 0x2f])]) : encoded
}

function makeHome(scenarios) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-herdr-smoke-'))
  for (const s of scenarios) {
    const dir = path.join(home, 'sessions', s.slug, s.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), journal(s.header, s.events, s))
  }
  return home
}

function header(id, slug = 'demo', depth = 0) {
  return {
    type: 'session', version: 4, id: `session-${id}`, createdAt: NOW - 1000,
    cwd: `/home/you/src/${slug}`, isSeeded: false, delegationDepth: depth, agentPreset: 'standard',
  }
}

let seq = 0
function event(type, data = {}) {
  seq += 1
  return { type, seq, time: NOW - 200 + seq, data }
}

function run(home, extra = []) {
  const state = path.join(home, 'state', 'agents.json')
  const result = spawnSync(process.execPath, [LAUNCHER, 'watch', '--once', '--no-osc', '--state', state, ...extra], {
    env: { ...process.env, DSH_HOME: home, DSH_HERDR_STATE: state, HC_TERMINAL_ID: '', HC_TERMINAL_SOCKET: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `launcher failed: ${result.stderr}`)
  return { summary: JSON.parse(result.stdout), state: JSON.parse(readFileSync(state, 'utf8')) }
}

console.log('dsh-herdr smoke tests')

// --- 1. one working session + one idle session -----------------------------
test('aggregates a working and an idle session', () => {
  const working = {
    slug: 'alpha', id: 'demo-working',
    header: header('working', 'alpha'),
    events: [
      event('session/title', { title: 'Fix the failing tests' }),
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cargo test"}' }),
    ],
  }
  const idle = {
    slug: 'beta', id: 'demo-idle',
    header: header('idle', 'beta'),
    events: [
      event('session/title', { title: 'Write the changelog' }),
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'done' } }),
    ],
  }
  const home = makeHome([working, idle])
  try {
    const { summary, state } = run(home)
    assert.equal(summary.aggregate.state, 'working')
    assert.equal(summary.aggregate.title, 'Fix the failing tests')
    assert.equal(summary.sessions.length, 2)
    const byTitle = Object.fromEntries(summary.sessions.map((s) => [s.title, s.status]))
    assert.equal(byTitle['Fix the failing tests'], 'working')
    assert.equal(byTitle['Write the changelog'], 'idle')
    assert.equal(state.sessions.length, 2)
    assert.equal(state.producer, 'dsh-herdr')
    assert.equal(state.schemaVersion ?? state.version, 1)
    assert.ok(state.updatedMs > 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// --- 2. a pending approval makes it blocked ---------------------------------
test('reports blocked/permission for a pending approval, then clears it', () => {
  const scenario = {
    slug: 'gamma', id: 'demo-approval',
    header: header('approval', 'gamma'),
    events: [
      event('session/title', { title: 'Deploy the service' }),
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'appr-1', toolName: 'bash', callId: 'c1' }),
    ],
  }
  const home = makeHome([scenario])
  try {
    const blocked = run(home)
    assert.equal(blocked.summary.aggregate.state, 'blocked')
    assert.equal(blocked.summary.aggregate.kind, 'permission')
    assert.match(blocked.summary.aggregate.msg, /approval: bash/)
    assert.equal(blocked.state.sessions[0].status, 'blocked')
    assert.equal(blocked.state.sessions[0].blockedReason, 'permission')

    // The same journal with the decision appended is no longer blocked.
    scenario.events.push(event('approval/decided', { id: 'appr-1', outcome: 'allowed-once' }))
    const decided = makeHome([scenario])
    try {
      const open = run(decided)
      assert.equal(open.summary.aggregate.state, 'working')
      assert.equal(open.state.sessions[0].status, 'working')
    } finally { rmSync(decided, { recursive: true, force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// --- 3. a pending user question also blocks ---------------------------------
test('reports blocked/question for an unanswered ask_user_question call', () => {
  const home = makeHome([{
    slug: 'delta', id: 'demo-question',
    header: header('question', 'delta'),
    events: [
      event('session/title', { title: 'Pick a release date' }),
      event('turn/start', { turn: 1 }),
      event('tool/call', {
        turn: 1, step: 1, callId: 'q1', name: 'ask_user_question',
        arguments: '{"questions":[{"question":"Which date should we ship?"}]}',
      }),
    ],
  }])
  try {
    const { summary } = run(home)
    assert.equal(summary.aggregate.state, 'blocked')
    assert.equal(summary.aggregate.kind, 'question')
    assert.match(summary.aggregate.msg, /Which date should we ship\?/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// --- 4. a truncated (mid-append) journal is still read ----------------------
test('tolerates a partially-written journal tail', () => {
  const home = makeHome([{
    slug: 'epsilon', id: 'demo-truncated',
    truncateTail: true,
    header: header('truncated', 'epsilon'),
    events: [event('session/title', { title: 'Partial write' }), event('turn/start', { turn: 1 })],
  }])
  try {
    const { summary } = run(home)
    assert.equal(summary.aggregate.state, 'working')
    assert.equal(summary.sessions[0].title, 'Partial write')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// --- 5. a top-level session outranks a busier sub-agent ---------------------
test('prefers the top-level session title over a sub-agent', () => {
  const home = makeHome([
    {
      slug: 'zeta', id: 'demo-top',
      header: header('top', 'zeta', 0),
      events: [event('session/title', { title: 'Top-level task' }), event('turn/start', { turn: 1 })],
    },
    {
      slug: 'zeta', id: 'demo-kid',
      header: header('kid', 'zeta', 1),
      events: [event('session/title', { title: 'Sub-agent task' }), event('turn/start', { turn: 1 })],
    },
  ])
  try {
    const { summary, state } = run(home)
    assert.equal(summary.aggregate.state, 'working')
    assert.equal(summary.aggregate.title, 'Top-level task')
    assert.ok(state.sessions.some((s) => s.depth === 1))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

console.log(`\n${passed} smoke test(s) passed`)
