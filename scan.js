/**
 * study-ops — scan layer.
 *
 * Reads the roster, the DDT/IDM data folders and the QC cache, and folds them
 * into one snapshot the panel and the agent both consume. Nothing here writes
 * to the data folders: the only writable paths are the state file, the QC
 * cache and the export folder, all under `stateDir`.
 */

import { mkdir, open, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const DAY = 86400000
const SESSION_LABEL = { '1': 'T0', '2': 'T1', '3': 'T2' }
const DDT_ORDER = ['T0', 'T1', 'T2']
const IDM_ORDER = ['phase1', 'phase2', 'phase3']

/* ------------------------------------------------------------------ *
 * small utilities
 * ------------------------------------------------------------------ */

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.some(v => String(v).trim() !== ''))
}

async function readHead(file, bytes = 16384) {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close().catch(() => {})
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

export function todayString(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function dayDiff(a, b) {
  // Whole days from b to a, both YYYY-MM-DD, immune to DST.
  const toUtc = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
  }
  const da = toUtc(a)
  const db = toUtc(b)
  if (!Number.isFinite(da) || !Number.isFinite(db)) return NaN
  return Math.round((da - db) / DAY)
}

export function addDays(date, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''))
  if (!m) return ''
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * DAY
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function normalizeSession(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return ''
  const digits = s.replace(/^0+/, '')
  if (s === '001' || digits === '1') return 'T0'
  if (s === '002' || digits === '2') return 'T1'
  if (s === '003' || digits === '3') return 'T2'
  return ''
}

/* ------------------------------------------------------------------ *
 * roster
 * ------------------------------------------------------------------ */

export async function readRoster(file) {
  const text = await readFile(file, 'utf8').catch(() => '')
  const rows = parseCsv(text)
  if (!rows.length) return { ok: false, error: '名单文件为空或读不到：' + file, byId: new Map() }
  const headerAt = rows.findIndex(r => r.some(v => String(v).trim() === '被试编号'))
  if (headerAt < 0) return { ok: false, error: '名单里找不到「被试编号」表头行', byId: new Map() }
  const header = rows[headerAt].map(v => String(v).trim())
  const at = name => header.indexOf(name)
  const iSeq = at('全局序号')
  const iCode = at('分组码')
  const iId = at('被试编号')
  const iAudio = at('音频文件')
  const iName = at('姓名')
  const iPhone = at('联系方式')
  const byId = new Map()
  for (const r of rows.slice(headerAt + 1)) {
    const id = String(r[iId] || '').trim()
    if (!/^\d{5}$/.test(id)) continue
    byId.set(id, {
      id,
      seq: iSeq >= 0 ? String(r[iSeq] || '').trim() : '',
      code: iCode >= 0 ? String(r[iCode] || '').trim() : '',
      audio: iAudio >= 0 ? String(r[iAudio] || '').trim() : '',
      name: iName >= 0 ? String(r[iName] || '').trim() : '',
      phone: iPhone >= 0 ? String(r[iPhone] || '').trim() : ''
    })
  }
  return { ok: true, byId }
}

/* ------------------------------------------------------------------ *
 * data folders
 * ------------------------------------------------------------------ */

function isRawCsv(name) {
  if (!/\.csv$/i.test(name)) return false
  if (name.startsWith('_')) return false
  if (/_clean\.csv$/i.test(name)) return false
  return true
}

async function listCsv(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    if (!e.isFile() || !isRawCsv(e.name)) continue
    const full = path.join(dir, e.name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    out.push({ path: full, name: e.name, mtimeMs: info.mtimeMs, size: info.size })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function headValue(rows, name) {
  const header = rows[0] || []
  const first = rows[1] || []
  const idx = header.indexOf(name)
  if (idx < 0) return ''
  return String(first[idx] == null ? '' : first[idx]).trim()
}

export async function scanDdt(dir) {
  const files = await listCsv(dir)
  const out = []
  for (const f of files) {
    const head = await readHead(f.path).catch(() => '')
    const rows = parseCsv(head)
    let participant = headValue(rows, 'participant')
    if (!/^\d{5}$/.test(participant)) {
      const m = /^(\d{5})_/.exec(f.name)
      participant = m ? m[1] : ''
    }
    const session = normalizeSession(headValue(rows, 'session'))
    let date = ''
    const rawDate = headValue(rows, 'date') || headValue(rows, 'expStart')
    const dm = /(\d{4}-\d{2}-\d{2})/.exec(rawDate) || /(\d{4}-\d{2}-\d{2})/.exec(f.name)
    if (dm) date = dm[1]
    out.push({ ...f, id: participant, session, date })
  }
  return out
}

export async function scanIdm(dir) {
  const result = {}
  for (const phase of IDM_ORDER) {
    const folder = path.join(dir, phase)
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const raw = []
    const clean = []
    for (const e of entries) {
      if (!e.isFile() || !/\.csv$/i.test(e.name)) continue
      const full = path.join(folder, e.name)
      const info = await stat(full).catch(() => null)
      if (!info) continue
      const m = /^(\d{5})_/.exec(e.name)
      const id = m ? m[1] : ''
      if (/_clean\.csv$/i.test(e.name)) clean.push({ id, path: full, name: e.name })
      else if (!e.name.startsWith('_')) raw.push({ id, path: full, name: e.name, mtimeMs: info.mtimeMs, size: info.size })
    }
    const byId = new Map()
    for (const f of raw) {
      if (!byId.has(f.id)) byId.set(f.id, [])
      byId.get(f.id).push(f)
    }
    const cleanById = new Set(clean.map(c => c.id))
    result[phase] = { byId, cleanById }
  }
  return result
}

/* ------------------------------------------------------------------ *
 * QC (python, one process for all changed files)
 * ------------------------------------------------------------------ */

const QC_TIMEOUT_MS = 120000

export async function runQc(cfg, files, force) {
  const cacheFile = path.join(cfg.stateDir, 'qc-cache.json')
  const cache = await readJson(cacheFile, {})
  if (force) for (const key of Object.keys(cache)) delete cache[key]
  const pending = []
  for (const f of files) {
    const key = `${Math.round(f.mtimeMs)}:${f.size}`
    const hit = cache[f.path]
    if (hit && hit.key === key) {
      f.qc = hit.result
    } else {
      pending.push({ file: f, key })
    }
  }
  if (!pending.length) {
    return { ok: true, parsed: 0, cached: files.length }
  }
  if (!cfg.pythonPath) {
    return { ok: false, error: '没有可用的 Python 解释器，逐试次质检跳过', parsed: 0, cached: files.length - pending.length }
  }
  const script = cfg.qcScript
  const payload = JSON.stringify({ codesDir: cfg.codesDir, files: pending.map(p => p.file.path) })
  const out = await new Promise(resolve => {
    let child
    try {
      child = spawn(cfg.pythonPath, ['-X', 'utf8', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message ? error.message : error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: `质检超时（${QC_TIMEOUT_MS / 1000}s）` })
    }, QC_TIMEOUT_MS)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish({ ok: false, error: String(error && error.message ? error.message : error) }))
    child.on('close', code => {
      if (code !== 0) {
        finish({ ok: false, error: (stderr || `python 退出码 ${code}`).trim().slice(0, 400) })
        return
      }
      try {
        finish(JSON.parse(stdout))
      } catch {
        finish({ ok: false, error: '质检输出不是 JSON：' + stdout.slice(0, 200) })
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(payload, 'utf8')
  })
  if (!out.ok) return { ok: false, error: out.error, parsed: 0, cached: files.length - pending.length }

  const byPath = new Map((out.results || []).map(r => [r.path, r]))
  for (const p of pending) {
    const result = byPath.get(p.file.path) || { ok: false, error: '质检没有返回这一份' }
    p.file.qc = result
    cache[p.file.path] = { key: p.key, result }
  }
  await writeJson(cacheFile, cache).catch(() => {})
  return { ok: true, parsed: pending.length, cached: files.length - pending.length }
}

/* ------------------------------------------------------------------ *
 * compose
 * ------------------------------------------------------------------ */

function emptySession() {
  return { state: 'missing', files: 0, trials: null, timeouts: null, flags: [] }
}

function qcState(qc) {
  if (!qc) return { state: 'ok', flags: [] }
  if (qc.ok !== true) return { state: 'warn', flags: ['质检失败'] }
  const flags = []
  let state = 'ok'
  if (qc.trials !== 60) {
    state = 'bad'
    flags.push(`试次 ${qc.trials}/60`)
  }
  if (qc.badCells > 0) {
    state = 'bad'
    flags.push(`${qc.badCells} 个格子不是 6 次`)
  }
  if (qc.timeoutShare > 0.10) {
    if (state === 'ok') state = 'warn'
    flags.push(`超时重做的试次占 ${Math.round(qc.timeoutShare * 100)}%`)
  }
  if (qc.fastShare > 0.05) {
    if (state === 'ok') state = 'warn'
    flags.push(`快于 0.2 秒的试次占 ${Math.round(qc.fastShare * 100)}%`)
  }
  if (qc.slowShare > 0.05) {
    if (state === 'ok') state = 'warn'
    flags.push(`慢于 10 秒的试次占 ${Math.round(qc.slowShare * 100)}%`)
  }
  return { state, flags }
}

/** 把规则语言翻译成人话：这条提示在说什么、大概是什么原因、该怎么处理。 */
function qcHint(state, flags) {
  if (state === 'bad') {
    return '试次数或每格试次数不达标，常见于中途退出、程序报错或文件被覆盖。这份数据先别直接用，打开原始 CSV 核对。'
  }
  const text = flags.join(' ')
  const hints = []
  if (/快于 0\.2 秒/.test(text)) {
    hints.push('有超过 5% 的试次在 0.2 秒内作答，可能是连点或没看清题目；翻一下原始 CSV 里这几个试次，确认没问题就点忽略。')
  }
  if (/慢于 10 秒/.test(text)) {
    hints.push('有超过 5% 的试次超过 10 秒，可能是走神、被打断或程序卡顿；结合现场记录判断要不要保留。')
  }
  if (/超时重做/.test(text)) {
    hints.push('超时重做的比例偏高，可能没理解任务或操作不熟；结合现场记录看。')
  }
  return hints.join(' ') || '规则判断为提醒级别，数据本身可用。'
}

function followupFor(id, t0date, state, today) {
  if (!t0date) return { due: '', state: 'unknown', days: null }
  const due = addDays(t0date, 7)
  const record = state.followups && state.followups[id]
  if (record && record.done) return { due, state: 'done', days: null }
  const diff = dayDiff(today, due)
  if (!Number.isFinite(diff)) return { due, state: 'unknown', days: null }
  if (diff < -2) return { due, state: 'scheduled', days: diff }
  if (diff <= 2) return { due, state: 'due', days: diff }
  return { due, state: 'overdue', days: diff }
}

/* ------------------------------------------------------------------ *
 * schedule
 * ------------------------------------------------------------------ */

/** 把 "9:00" / "09:00" / "9:0" 统一成 "09:00"；读不懂就留空。 */
export function normalizeClock(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value == null ? '' : value).trim())
  if (!m) return ''
  const hour = Number(m[1])
  if (!Number.isFinite(hour) || hour > 23) return ''
  return String(hour).padStart(2, '0') + ':' + m[2]
}

function clockMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60
}

export async function readSchedule(cfg) {
  const raw = await readJson(path.join(cfg.stateDir, 'schedule.json'), { items: [] })
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : [])
  return items
    .filter(item => item && /^\d{5}$/.test(String(item.id || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')))
    .map(item => ({
      key: String(item.key || ''),
      id: String(item.id),
      date: String(item.date),
      start: normalizeClock(item.start),
      end: normalizeClock(item.end),
      note: String(item.note || ''),
      createdAt: String(item.createdAt || '')
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.start) - clockMinutes(b.start))
}

export async function addSchedule(cfg, payload) {
  const id = String((payload && payload.id) || '').trim()
  const date = String((payload && payload.date) || '').trim()
  if (!/^\d{5}$/.test(id)) throw new Error('被试编号应为 5 位数字')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD')
  const items = await readSchedule(cfg)
  const item = {
    key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    id,
    date,
    start: normalizeClock((payload && payload.start) || ''),
    end: normalizeClock((payload && payload.end) || ''),
    note: String((payload && payload.note) || '').trim(),
    createdAt: new Date().toISOString()
  }
  items.push(item)
  await writeJson(path.join(cfg.stateDir, 'schedule.json'), { items })
  return item
}

export async function removeSchedule(cfg, key) {
  const items = (await readSchedule(cfg)).filter(item => item.key !== key)
  await writeJson(path.join(cfg.stateDir, 'schedule.json'), { items })
  return items
}

export async function removeScheduleMatch(cfg, match = {}) {
  const key = String(match.key || '')
  const id = String(match.id || '')
  const date = String(match.date || '')
  if (!key && !id) throw new Error('删除安排需要 key 或编号')
  const items = (await readSchedule(cfg)).filter(item => {
    if (key) return item.key !== key
    return !(item.id === id && (!date || item.date === date))
  })
  await writeJson(path.join(cfg.stateDir, 'schedule.json'), { items })
  return items
}

/* ------------------------------------------------------------------ *
 * demographics mirror (written by the demographic-coder plugin)
 * ------------------------------------------------------------------ */

export async function readDemographics(cfg) {
  const raw = await readJson(path.join(cfg.stateDir, 'demographics.json'), null)
  if (!raw || !Array.isArray(raw.rows)) {
    return { present: false, byId: new Map(), total: 0, name: '', updatedAt: '' }
  }
  const columns = Array.isArray(raw.columns) ? raw.columns : []
  const total = columns.length
  const byId = new Map()
  for (const row of raw.rows) {
    const id = String((row && row.id) || '').trim()
    if (!/^\d{5}$/.test(id)) continue
    const filled = total
      ? columns.filter(column => String(row[column.key] == null ? '' : row[column.key]).trim() !== '').length
      : Object.keys(row).filter(key => key !== 'id' && String(row[key] == null ? '' : row[key]).trim() !== '').length
    byId.set(id, { filled, total })
  }
  return {
    present: true,
    byId,
    total,
    name: String(raw.name || ''),
    updatedAt: String(raw.updatedAt || raw.exportedAt || '')
  }
}

export async function saveT0(cfg, id, date) {
  const file = path.join(cfg.stateDir, 'state.json')
  const state = await loadState(cfg)
  state.t0 = state.t0 || {}
  state.t0[id] = date
  await writeJson(file, state)
  return state
}

export async function compose(cfg, scanned, state, today) {
  const { roster, ddt, idm, schedule = [], demo } = scanned
  const scheduleById = new Map()
  for (const item of schedule) {
    if (!scheduleById.has(item.id)) scheduleById.set(item.id, [])
    scheduleById.get(item.id).push(item)
  }
  const ids = new Set()
  for (const f of ddt) ids.add(f.id)
  for (const phase of IDM_ORDER) for (const id of idm[phase].byId.keys()) ids.add(id)
  for (const [id, entry] of roster.byId) if (entry.name) ids.add(id)
  for (const item of schedule) ids.add(item.id)

  const subjects = []
  const anomalies = []
  let enrolled = 0
  let enrolledLast7 = 0
  let registeredCount = 0
  let pendingDataCount = 0
  const cells = {}
  const perCell = cfg.targetPerCell || 32

  for (const id of [...ids].sort()) {
    const entry = roster.byId.get(id) || { id, code: id.slice(0, 2), audio: '', name: '', phone: '' }
    const code = id.slice(0, 2)
    const files = ddt.filter(f => f.id === id)
    const idmLists = Object.fromEntries(IDM_ORDER.map(p => [p, idm[p].byId.get(id) || []]))
    const anyData = files.length > 0 || IDM_ORDER.some(p => idmLists[p].length > 0)
    const registered = Boolean(entry.name)
    const pendingData = registered && !anyData
    const planned = !registered && !anyData
    const sessions = { T0: emptySession(), T1: emptySession(), T2: emptySession() }
    const flags = []
    if (entry.code && entry.code !== code) {
      flags.push(`名单分组码 ${entry.code} 与编号不符`)
      anomalies.push({
        id, code: 'roster', level: 'bad',
        text: `名单分组码 ${entry.code} 与编号 ${id} 不符`,
        hint: '名单里的分组码和编号前两位对不上，多半是手填错了。以编号为准去改名单，不要改编号。'
      })
    }
    for (const f of files) {
      const label = f.session
      if (!label) {
        flags.push('有一份 CSV 读不出 session')
        anomalies.push({
          id, code: 'session', level: 'bad',
          text: `${f.name} 读不出 session`,
          hint: 'CSV 里读不出 session 列，可能不是这个任务的输出，或者文件损坏。打开文件头看一眼再决定怎么处理。'
        })
        continue
      }
      const slot = sessions[label]
      slot.files += 1
      if (f.qc && f.qc.ok) {
        slot.trials = f.qc.trials
        slot.timeouts = f.qc.timeouts
        slot.rtMedian = f.qc.rtMedian
        slot.rtMax = f.qc.rtMax
        slot.llRate = f.qc.llRate
        slot.participant = f.qc.participant
        slot.file = f.name
      }
      const qs = qcState(f.qc)
      slot.flags.push(...qs.flags)
      if (qs.state === 'bad' || slot.state === 'bad') slot.state = 'bad'
      else if (qs.state === 'warn' && slot.state !== 'bad') slot.state = 'warn'
      else if (slot.state === 'missing') slot.state = 'ok'
    }
    for (const label of DDT_ORDER) {
      const slot = sessions[label]
      if (slot.files === 0) {
        slot.state = 'missing'
        if (anyData) {
          flags.push(`缺 ${label}`)
          anomalies.push({
            id, code: 'missing', session: label, level: 'bad',
            text: `缺 ${label} 的 DDT 数据`,
            hint: '这个时间点的 CSV 不在。先确认是不是还没从采集电脑拷过来；如果被试确实漏做，就记为缺失，并在排除记录里写明原因。'
          })
        }
      } else if (slot.files > 1) {
        if (slot.state !== 'bad') slot.state = 'warn'
        flags.push(`${label} 有 ${slot.files} 份文件`)
        anomalies.push({
          id, code: 'duplicate', session: label, level: 'warn',
          text: `${label} 有 ${slot.files} 份 DDT 文件`,
          hint: '同一时间点有不止一份 CSV，可能是重跑、重复拷贝或命名冲突。统计会把它们都算进去，先确认哪一份是正式数据。'
        })
      }
      if (!anyData) continue
      if (slot.state === 'bad') {
        anomalies.push({
          id, code: 'qc', session: label, level: 'bad',
          text: `${label} 质控不通过：${slot.flags.join('、')}`,
          hint: qcHint('bad', slot.flags)
        })
      } else if (slot.state === 'warn') {
        anomalies.push({
          id, code: 'qc', session: label, level: 'warn',
          text: `${label} 需要留意：${slot.flags.join('、')}`,
          hint: qcHint('warn', slot.flags)
        })
      }
    }

    const idmState = {}
    for (const phase of IDM_ORDER) {
      const list = idmLists[phase]
      const hasClean = idm[phase].cleanById.has(id)
      let st = 'missing'
      if (list.length === 1) st = hasClean || phase !== 'phase2' ? 'ok' : 'warn'
      else if (list.length > 1) st = 'warn'
      idmState[phase] = { state: st, files: list.length, clean: hasClean }
      if (!anyData) continue
      if (st === 'missing') {
        anomalies.push({
          id, code: 'idm', session: phase, level: 'warn',
          text: `缺 ${phase} 的 IDM 数据`,
          hint: 'IDM 这一阶段的文件不在。确认 llmDD 的对应阶段有没有跑完、有没有拷进 正式实验数据/IDM。'
        })
      } else if (st === 'warn') {
        anomalies.push({
          id, code: 'idm', session: phase, level: 'warn',
          text: `${phase} 需要留意（文件数 ${list.length}${hasClean ? '' : '，无 clean'}）`,
          hint: 'IDM 文件数量不对，或者缺少 _clean 清洗结果。先跑一遍清洗脚本；多出来的文件要确认哪份是正式的。'
        })
      }
    }

    const t0File = files.find(f => f.session === 'T0' && f.date)
    let t0date = t0File ? t0File.date : ''
    let t0source = t0File ? 'data' : ''
    if (!t0date && state.t0 && state.t0[id]) {
      t0date = state.t0[id]
      t0source = 'manual'
    }
    if (!t0date) {
      const past = (scheduleById.get(id) || [])
        .map(item => item.date)
        .filter(date => date && dayDiff(today, date) >= 0)
        .sort()
      if (past.length) {
        t0date = past[past.length - 1]
        t0source = 'schedule'
      }
    }
    if (pendingData && t0date) {
      const age = dayDiff(today, t0date)
      if (age > 2) {
        anomalies.push({
          id, code: 'pending', level: 'warn',
          text: `名单已登记 ${age} 天，DDT/IDM 数据仍未导入`,
          hint: '名单上已经登记，但超过两天还没看到数据。确认文件是不是还在采集电脑上，或者拷贝时漏了这一个人。'
        })
      }
    }

    const demoEntry = demo && demo.byId ? demo.byId.get(id) : null
    const demoState = {
      present: Boolean(demoEntry),
      filled: demoEntry ? demoEntry.filled : 0,
      total: demoEntry ? demoEntry.total : (demo && demo.total ? demo.total : 0)
    }

    const followup = followupFor(id, t0date, state, today)

    if (registered || anyData) {
      enrolled += 1
      if (registered) registeredCount += 1
      if (pendingData) pendingDataCount += 1
      cells[code] = (cells[code] || 0) + 1
      if (t0date && dayDiff(today, t0date) <= 7 && dayDiff(today, t0date) >= 0) enrolledLast7 += 1
    }

    subjects.push({
      id,
      code,
      audio: entry.audio,
      registered,
      pendingData,
      planned,
      t0: t0date,
      t0source,
      sessions,
      idm: idmState,
      demo: demoState,
      flags,
      followup
    })
  }

  const cellKeys = Object.keys(cells).sort()
  const pace = enrolledLast7 / 7
  const remaining = Math.max(0, (cfg.targetTotal || 150) - enrolled)
  const etaDays = pace > 0.05 ? Math.ceil(remaining / pace) : null

  const dismissedMap = state.dismissed || {}
  const seen = new Set()
  const uniqueAnomalies = []
  const dismissedAnomalies = []
  for (const a of anomalies) {
    const key = [a.id, a.code || 'misc', a.session || ''].join('|')
    const entry = { ...a, key }
    const record = dismissedMap[key]
    if (record) {
      dismissedAnomalies.push({ ...entry, dismissedAt: record.at || '', note: record.note || '' })
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    uniqueAnomalies.push(entry)
  }
  uniqueAnomalies.sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'bad' ? -1 : 1))
  dismissedAnomalies.sort((a, b) => a.id.localeCompare(b.id))

  const byId = new Map(subjects.map(s => [s.id, s]))
  const scheduleOut = schedule.map(item => {
    const subject = byId.get(item.id)
    const diff = dayDiff(today, item.date)
    const phase = diff > 0 ? 'past' : diff === 0 ? 'today' : 'future'
    let status = 'planned'
    if (subject && subject.sessions.T0.files > 0) status = 'data'
    else if (subject && subject.registered) status = 'tested'
    else if (phase === 'past') status = 'missed'
    return { ...item, phase, status }
  }).sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.start) - clockMinutes(b.start))

  const enrolledSubjects = subjects.filter(s => !s.planned)
  const demoDone = enrolledSubjects.filter(s => s.demo.present && s.demo.total > 0 && s.demo.filled >= s.demo.total).length
  const demoPartial = enrolledSubjects.filter(s => s.demo.present && s.demo.filled > 0 && s.demo.filled < s.demo.total).length
  const demoMissing = enrolledSubjects.length - demoDone - demoPartial

  return {
    generatedAt: new Date().toISOString(),
    today,
    project: cfg.projectRoot,
    target: { total: cfg.targetTotal || 150, perCell },
    enrollment: {
      n: enrolled,
      registered: registeredCount,
      pendingData: pendingDataCount,
      cells: Object.fromEntries(['11', '12', '21', '22'].map(code => [code, { n: cells[code] || 0, target: perCell }])),
      last7: enrolledLast7,
      pacePerDay: Math.round(pace * 10) / 10,
      etaDays,
      etaDate: etaDays == null ? '' : addDays(today, etaDays)
    },
    subjects,
    schedule: scheduleOut,
    demographics: {
      present: Boolean(demo && demo.present),
      name: (demo && demo.name) || '',
      updatedAt: (demo && demo.updatedAt) || '',
      total: (demo && demo.total) || 0,
      done: demoDone,
      partial: demoPartial,
      missing: demoMissing
    },
    anomalies: uniqueAnomalies,
    dismissed: dismissedAnomalies,
    counts: {
      subjects: subjects.length,
      enrolled,
      registered: registeredCount,
      pendingData: pendingDataCount,
      dismissed: dismissedAnomalies.length,
      planned: subjects.filter(s => s.planned).length,
      planToday: scheduleOut.filter(item => item.phase === 'today').length,
      planTomorrow: scheduleOut.filter(item => item.phase === 'future' && item.date === addDays(today, 1)).length,
      bad: uniqueAnomalies.filter(a => a.level === 'bad').length,
      warn: uniqueAnomalies.filter(a => a.level === 'warn').length,
      followupDue: subjects.filter(s => s.followup.state === 'due').length,
      followupOverdue: subjects.filter(s => s.followup.state === 'overdue').length
    }
  }
}

/* ------------------------------------------------------------------ *
 * orchestration
 * ------------------------------------------------------------------ */

export async function buildSnapshot(cfg, options = {}) {
  const force = Boolean(options.force)
  const roster = await readRoster(cfg.rosterPath)
  const ddt = await scanDdt(cfg.dataDir)
  const idm = await scanIdm(cfg.idmDir)
  const qc = await runQc(cfg, ddt, force)
  const [schedule, demo] = await Promise.all([readSchedule(cfg), readDemographics(cfg)])
  const state = await readJson(path.join(cfg.stateDir, 'state.json'), { followups: {} })
  const today = todayString()
  const snapshot = await compose(cfg, { roster, ddt, idm, schedule, demo }, state, today)
  snapshot.qc = { ok: qc.ok, error: qc.error || '', parsed: qc.parsed, cached: qc.cached }
  snapshot.files = { ddt: ddt.length, idm: IDM_ORDER.reduce((n, p) => n + idm[p].byId.size, 0) }
  if (!roster.ok) snapshot.rosterError = roster.error
  return snapshot
}

export async function loadState(cfg) {
  return readJson(path.join(cfg.stateDir, 'state.json'), { followups: {} })
}

export async function saveFollowup(cfg, id, done) {
  const file = path.join(cfg.stateDir, 'state.json')
  const state = await loadState(cfg)
  state.followups = state.followups || {}
  state.followups[id] = { done: Boolean(done), at: todayString() }
  await writeJson(file, state)
  return state
}

/** 忽略一条异常：按 key 记下时间与备注，告警列表里收起，仍可在「已忽略」里恢复。 */
export async function dismissAnomaly(cfg, key, note) {
  const clean = String(key || '').trim()
  if (!clean) throw new Error('缺少异常 key')
  const file = path.join(cfg.stateDir, 'state.json')
  const state = await loadState(cfg)
  state.dismissed = state.dismissed || {}
  state.dismissed[clean] = { at: todayString(), note: String(note || '').trim() }
  await writeJson(file, state)
  return state
}

export async function restoreAnomaly(cfg, key) {
  const file = path.join(cfg.stateDir, 'state.json')
  const state = await loadState(cfg)
  state.dismissed = state.dismissed || {}
  const clean = String(key || '').trim()
  if (clean) delete state.dismissed[clean]
  else state.dismissed = {}
  await writeJson(file, state)
  return state
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

function cellMark(session) {
  if (!session) return '—'
  if (session.state === 'ok') return '✓'
  if (session.state === 'warn') return '⚠'
  if (session.state === 'bad') return '✗'
  return '·'
}

function followLabel(state) {
  if (state === 'done') return '已完成'
  if (state === 'scheduled') return '未到期'
  if (state === 'due') return '本周到期'
  if (state === 'overdue') return '逾期'
  return '—'
}

export async function exportReport(cfg, snapshot) {
  const dir = path.join(cfg.stateDir, 'export')
  await mkdir(dir, { recursive: true })
  const stamp = snapshot.today.replace(/-/g, '')
  const base = `被试进度与质控_${stamp}`
  const lines = []
  lines.push('# 被试进度与质控')
  lines.push('')
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}　数据源：\`${snapshot.project}\``)
  lines.push('')
  lines.push(`已入组 **${snapshot.enrollment.n} / ${snapshot.target.total}**；近 7 天 ${snapshot.enrollment.last7} 人，约 ${snapshot.enrollment.pacePerDay} 人/天` +
    (snapshot.enrollment.etaDate ? `，预计 ${snapshot.enrollment.etaDate} 收完` : '') + '。')
  lines.push('')
  lines.push('| 格子 | 已入组 | 目标 |')
  lines.push('|---|---|---|')
  for (const [code, cell] of Object.entries(snapshot.enrollment.cells)) {
    lines.push(`| ${code} | ${cell.n} | ${cell.target} |`)
  }
  lines.push('')
  lines.push('## 异常')
  lines.push('')
  if (!snapshot.anomalies.length) {
    lines.push('无。')
  } else {
    for (const a of snapshot.anomalies) {
      lines.push(`- [${a.level === 'bad' ? '高' : '中'}] ${a.id}：${a.text}`)
      if (a.hint) lines.push(`  - 说明：${a.hint}`)
    }
  }
  lines.push('')
  lines.push('## 被试一览')
  lines.push('')
  lines.push('| 编号 | 分组 | 人口学 | T0 | T1 | T2 | IDM1 | IDM2 | IDM3 | 随访 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const s of snapshot.subjects.filter(x => !x.planned)) {
    const demo = s.demo && s.demo.present ? `${s.demo.filled}/${s.demo.total}` : '—'
    lines.push(`| ${s.id} | ${s.code} | ${demo} | ${cellMark(s.sessions.T0)} | ${cellMark(s.sessions.T1)} | ${cellMark(s.sessions.T2)} | ` +
      `${cellMark(s.idm.phase1)} | ${cellMark(s.idm.phase2)} | ${cellMark(s.idm.phase3)} | ${followLabel(s.followup.state)} |`)
  }
  lines.push('')
  lines.push('> 导出不含姓名与联系方式；原始数据未被修改。')
  const md = lines.join('\n')
  const csv = ['被试编号,分组,人口学已填,人口学总项,T0,T1,T2,IDM1,IDM2,IDM3,随访到期,随访状态']
    .concat(snapshot.subjects.filter(x => !x.planned).map(s => [
      s.id, s.code,
      s.demo.present ? s.demo.filled : 0, s.demo.total || 0,
      s.sessions.T0.state, s.sessions.T1.state, s.sessions.T2.state,
      s.idm.phase1.state, s.idm.phase2.state, s.idm.phase3.state,
      s.followup.due, s.followup.state
    ].join(',')))
    .join('\n')
  const mdPath = path.join(dir, base + '.md')
  const csvPath = path.join(dir, base + '.csv')
  await writeFile(mdPath, md, 'utf8')
  await writeFile(csvPath, '\ufeff' + csv, 'utf8')
  return { dir, files: [{ name: base + '.md', path: mdPath }, { name: base + '.csv', path: csvPath }] }
}
