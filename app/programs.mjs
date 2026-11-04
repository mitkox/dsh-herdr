/** Merge Herdr program defaults and undo only fields this installer added. */
import fs from 'node:fs'
import path from 'node:path'

const [mode, target, source] = process.argv.slice(2)
if (!target || !['install', 'uninstall'].includes(mode)) throw new Error('usage: programs.mjs install|uninstall <programs.json> [defaults.json]')
const ownership = `${target}.dsh-herdr.json`
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
const write = (file, document) => {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally { fs.rmSync(tmp, { force: true }) }
}

const document = read(target, {})
if (!object(document) || (own(document, 'programs') && !object(document.programs))) {
  throw new Error(`invalid program table in ${target}; existing configuration kept`)
}
let record = read(ownership, null)
if (record && (record.version !== 1 || !object(record.added) || !Array.isArray(record.created))) {
  throw new Error(`invalid installation ownership record ${ownership}; configuration kept`)
}

if (mode === 'install') {
  const defaults = read(source, null)
  if (!object(defaults?.programs)) throw new Error('invalid program defaults')
  record ??= { version: 1, hadPrograms: own(document, 'programs'), added: {}, created: [] }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const backup = `${target}.dsh-herdr.bak`
  if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup)
  const programs = document.programs ??= {}
  for (const [key, entry] of Object.entries(defaults.programs)) {
    if (own(programs, key) && !object(programs[key])) continue
    if (!own(programs, key)) {
      programs[key] = {}
      record.created.push(key)
    }
    for (const [field, value] of Object.entries(entry)) {
      if (own(programs[key], field)) continue
      programs[key][field] = value
      ;(record.added[key] ??= {})[field] = value
    }
  }
  write(ownership, record)
  write(target, document)
  console.log(`merged program defaults into ${target}; existing values kept`)
} else if (record) {
  const programs = document.programs ?? {}
  for (const [key, fields] of Object.entries(record.added)) {
    if (!object(programs[key])) continue
    for (const [field, installed] of Object.entries(fields)) {
      if (JSON.stringify(programs[key][field]) === JSON.stringify(installed)) delete programs[key][field]
    }
    if (record.created.includes(key) && Object.keys(programs[key]).length === 0) delete programs[key]
  }
  if (!record.hadPrograms && Object.keys(programs).length === 0) delete document.programs
  write(target, document)
  fs.rmSync(ownership)
  console.log(`removed installed program defaults from ${target}; customizations kept`)
} else {
  console.log(`no installation ownership record; kept existing program entries in ${target}`)
}
