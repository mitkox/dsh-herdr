import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bin = path.join(home, 'stubs')
  const app = path.join(home, 'app')
  fs.mkdirSync(bin)
  fs.mkdirSync(app)
  for (const [name, body] of Object.entries({
    hc: 'echo \'{"terminals":[]}\'',
    'herdr-app': 'if [ "$1" = status ]; then echo \'{"errors":[]}\'; fi',
    systemctl: 'exit 0',
    // The plugin installer needs a dsh binary even for --dry-run; CI has none.
    dsh: 'exit 0',
  })) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const env = {
    ...process.env, HOME: home, HERDR_APP_HOME: app, DSH_HOME: path.join(home, 'dsh'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), PATH: bin + path.delimiter + process.env.PATH,
    DSH_BIN: path.join(bin, 'dsh'),
    HC_TERMINAL_ID: '', HC_TERMINAL_SOCKET: '', HERDR_ENV: '', DSH_HERDR_STATE: '',
  }
  const run = (command, args = [], expected = 0) => {
    const result = spawnSync(command, args, { env, cwd: home, encoding: 'utf8', timeout: 8000 })
    assert.ifError(result.error)
    assert.equal(result.status, expected, result.stdout + result.stderr)
    return result
  }
  return { home, app, env, run, programs: path.join(app, 'programs.json') }
}

test('installed command can reinstall and uninstall while preserving custom programs', (t) => {
  const f = fixture(t)
  const original = { customRoot: true, programs: {
    other: { name: 'Unrelated' },
    'dsh-tui': { name: 'My DSH', run: ['custom-dsh'] },
    'dsh-herdr': { run: ['my-monitor'], extra: true },
  } }
  fs.writeFileSync(f.programs, JSON.stringify(original))
  f.run('bash', [path.join(repo, 'install.sh')])
  assert.deepEqual(JSON.parse(fs.readFileSync(f.programs + '.dsh-herdr.bak', 'utf8')), original)
  const installed = path.join(f.home, '.local/bin/dsh-herdr')
  f.run(installed, ['install'])
  const edited = JSON.parse(fs.readFileSync(f.programs, 'utf8'))
  edited.programs.later = { name: 'Added later' }
  edited.programs['dsh-tui'].color = '#123456'
  fs.writeFileSync(f.programs, JSON.stringify(edited))
  f.run(installed, ['uninstall'])
  const expected = structuredClone(original)
  expected.programs.later = edited.programs.later
  expected.programs['dsh-tui'].color = '#123456'
  assert.deepEqual(JSON.parse(fs.readFileSync(f.programs, 'utf8')), expected)
  assert.equal(fs.existsSync(installed), false)
  assert.equal(fs.existsSync(path.join(f.home, 'data/dsh-herdr')), false)
  assert.equal(fs.existsSync(path.join(f.app, 'mods/dsh-monitor')), false)
})

test('fresh install removal restores an empty table and keeps a second mod', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.app, 'mods/other'), { recursive: true })
  fs.writeFileSync(f.programs, '{}')
  f.run('bash', [path.join(repo, 'app/install.sh')])
  f.run('bash', [path.join(repo, 'app/install.sh')])
  f.run('bash', [path.join(repo, 'app/install.sh'), '--uninstall'])
  assert.deepEqual(JSON.parse(fs.readFileSync(f.programs, 'utf8')), {})
  assert.ok(fs.existsSync(path.join(f.app, 'mods/other')))
})

test('monitor uninstall preserves the native plugin linked into its DSH profile', (t) => {
  const f = fixture(t)
  const dsh = path.join(f.home, 'stubs/dsh')
  fs.writeFileSync(dsh, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
const dir = path.join(process.env.DSH_HOME, 'profiles', args[2])
fs.mkdirSync(dir, {recursive:true})
const file = path.join(dir, 'package.json')
if (args[3] === 'add') fs.writeFileSync(file, JSON.stringify({dependencies:{'dsh-plugin-herdr':'link:'+args[4]},dsh:{profile:{bundles:[]}}}))
else {const doc=JSON.parse(fs.readFileSync(file)); delete doc.dependencies['dsh-plugin-herdr']; fs.writeFileSync(file,JSON.stringify(doc))}
`, { mode: 0o755 })
  f.run('bash', [path.join(repo, 'install.sh'), '--plugin'])
  const profile = path.join(f.env.DSH_HOME, 'profiles/herdr/package.json')
  const linked = JSON.parse(fs.readFileSync(profile, 'utf8')).dependencies['dsh-plugin-herdr'].slice(5)
  assert.equal(linked, path.join(f.home, 'data/dsh-herdr/plugin'))
  const installed = path.join(f.home, '.local/bin/dsh-herdr')
  f.run(installed, ['uninstall'])
  assert.ok(fs.existsSync(path.join(linked, 'index.js')))
  f.run('bash', [path.join(linked, 'install.sh'), '--uninstall'])
  assert.equal(JSON.parse(fs.readFileSync(profile, 'utf8')).dependencies['dsh-plugin-herdr'], undefined)
})

test('invalid program JSON and unknown install options leave configuration intact', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.programs, '{broken')
  f.run('bash', [path.join(repo, 'app/install.sh')], 1)
  assert.equal(fs.readFileSync(f.programs, 'utf8'), '{broken')
  f.run('bash', [path.join(repo, 'install.sh'), '--unknown'], 1)
  assert.equal(fs.existsSync(path.join(f.home, '.local/bin/dsh-herdr')), false)
})

test('plugin installer keeps the live web profile behind the explicit guard', (t) => {
  const f = fixture(t)
  const script = path.join(repo, 'plugin/install.sh')
  f.run('bash', [script, '--profile', 'web', '--dry-run'], 2)
  f.run('bash', [script, '--profile', 'herdr', '--dry-run'])
  assert.equal(fs.existsSync(path.join(f.env.DSH_HOME, 'profiles/web')), false)
})

test('synthetic probe rejects an incorrect Herdr status instead of passing', (t) => {
  const f = fixture(t)
  const hc = path.join(f.home, 'stubs/hc')
  fs.writeFileSync(hc, '#!/bin/sh\nif [ "$1" = get ]; then echo \'{"reported":true,"status":{"state":"working"}}\'; else echo \'{}\'; fi\n', { mode: 0o755 })
  const result = spawnSync('bash', [path.join(repo, 'monitor/tests/test-synthetic-herdr.sh')], {
    env: { ...f.env, SYNTH_DIR: path.join(f.home, 'synthetic') }, encoding: 'utf8', timeout: 8000,
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /expected idle terminal state/)
})
