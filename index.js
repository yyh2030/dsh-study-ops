/**
 * study-ops — Host half.
 *
 * One HTTP route serves the panel; one agent tool exposes the same snapshot
 * without names or phone numbers. The data folders are read-only here: the
 * route may write the follow-up state, the QC cache and report exports, all
 * under `stateDir`.
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addSchedule, buildSnapshot, dismissAnomaly, exportReport, loadState, readRoster, removeSchedule, removeScheduleMatch, restoreAnomaly, saveFollowup, saveT0, setAttendance, todayString } from './scan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/api/study-ops'
const HEADER = 'x-study-ops'
const CACHE_TTL_MS = 30000

const DEFAULTS = {
  projectRoot: 'C:/Users/16787/OneDrive/Desktop/yyh硕士论文',
  targetTotal: 150,
  targetPerCell: 32
}

class RouteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new RouteError('too_large', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new RouteError('invalid', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  try {
    return new URL(origin).host === String(req.headers.host || '')
  } catch {
    return false
  }
}

function resolveConfig(config) {
  const root = path.resolve(String(config.projectRoot || DEFAULTS.projectRoot).replace(/\\/g, '/'))
  const join = (...parts) => path.join(root, ...parts).replace(/\\/g, '/')
  const cfg = {
    projectRoot: root,
    dataDir: config.dataDir || join('正式实验数据', 'DDT'),
    idmDir: config.idmDir || join('正式实验数据', 'IDM'),
    rosterPath: config.rosterPath || join('Mortality 正式实验材料（主试用）', '00_主试操作清单', '被试分组名单_全局序号-编号-分组-音频.csv'),
    codesDir: config.codesDir || join('03_延迟折扣任务与代码', 'Codes'),
    stateDir: config.stateDir || join('_lab'),
    pythonPath: config.pythonPath || 'C:/Users/16787/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    qcScript: path.join(HERE, 'qc.py'),
    targetTotal: Number(config.targetTotal) || DEFAULTS.targetTotal,
    targetPerCell: Number(config.targetPerCell) || DEFAULTS.targetPerCell
  }
  return cfg
}

/** Keep only the numbers the panel and the agent need; no names, no phones. */
function publicSnapshot(snapshot) {
  return snapshot
}

function summaryText(snapshot, focus) {
  const lines = []
  const e = snapshot.enrollment
  if (focus !== 'anomalies' && focus !== 'followup') {
    lines.push(`已入组 ${e.n}/${snapshot.target.total}（名单登记 ${e.registered}，数据已到 ${e.n - e.pendingData}，数据待导入 ${e.pendingData}；近 7 天 ${e.last7} 人${e.etaDate ? '，预计 ' + e.etaDate + ' 收完' : ''}）。`)
    const cells = Object.entries(e.cells).map(([code, c]) => `${code} ${c.n}/${c.target}`).join('，')
    lines.push(`四格：${cells}。`)
    const demo = snapshot.demographics
    lines.push(`人口学：完成 ${demo.done}，部分 ${demo.partial}，缺 ${demo.missing}${demo.present ? '' : '（人口学录入还没同步过）'}。`)
    const plan = (snapshot.schedule || []).filter(item => item.phase === 'today' || item.phase === 'future')
    if (plan.length) {
      lines.push('安排：')
      for (const item of plan.slice(0, 10)) {
        const when = item.phase === 'today' ? '今天' : item.date
        const time = item.start ? ` ${item.start}${item.end ? '–' + item.end : ''}` : ''
        const status = item.status === 'data' ? '数据已到' : item.status === 'tested' ? '已登记' : '未到'
        lines.push(`- ${when}${time} ${item.id}（${status}）`)
      }
    }
  }
  if (focus !== 'anomalies' && focus !== 'followup') {
    const bad = snapshot.anomalies.filter(a => a.level === 'bad')
    const warn = snapshot.anomalies.filter(a => a.level !== 'bad')
    lines.push(`异常：高 ${bad.length} 条，中 ${warn.length} 条。`)
    for (const a of [...bad, ...warn].slice(0, 8)) {
      lines.push(`- [${a.level === 'bad' ? '高' : '中'}] ${a.id}：${a.text}`)
      if (a.hint) lines.push(`  ${a.hint}`)
    }
    if (snapshot.anomalies.length > 8) lines.push(`（还有 ${snapshot.anomalies.length - 8} 条，见面板）`)
    if (snapshot.counts && snapshot.counts.dismissed) lines.push(`另有 ${snapshot.counts.dismissed} 条已忽略（面板里可恢复）。`)
  }
  if (focus !== 'summary' && focus !== 'anomalies') {
    const due = snapshot.subjects.filter(s => s.followup.state === 'due' || s.followup.state === 'overdue')
    lines.push(due.length ? `随访待办 ${due.length} 人：` : '随访：暂无到期。')
    for (const s of due) {
      lines.push(`- ${s.id}：${s.followup.due} 到期，${s.followup.state === 'overdue' ? `已逾期 ${Math.abs(s.followup.days)} 天` : '本周内'}`)
    }
  }
  if (snapshot.qc && snapshot.qc.ok === false) lines.push(`注意：逐试次质检不可用（${snapshot.qc.error}），当前只按文件是否齐全判断。`)
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config || {})
  let cache = null
  let building = null

  async function snapshot(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
    if (building) return building
    building = (async () => {
      try {
        // 刷新只绕过 30 秒的内存缓存；逐试次质检仍按文件 mtime+size 命中缓存，
        // 所以「刷一下」通常几十毫秒，只有新导入的文件才会重新解析。
        const value = await buildSnapshot(cfg, { force: false })
        cache = { at: Date.now(), value }
        return value
      } finally {
        building = null
      }
    })()
    return building
  }

  async function subjectDetail(id) {
    const snap = await snapshot(false)
    const subject = snap.subjects.find(s => s.id === id)
    if (!subject) throw new RouteError('not_found', '没有这个被试：' + id)
    const roster = await readRoster(cfg.rosterPath)
    const entry = roster.byId.get(id) || null
    return {
      subject,
      contact: entry ? { name: entry.name, phone: entry.phone, audio: entry.audio, code: entry.code, seq: entry.seq } : null
    }
  }

  const actions = {
    async status() {
      return publicSnapshot(await snapshot(false))
    },
    async refresh() {
      return publicSnapshot(await snapshot(true))
    },
    async subject(payload) {
      const id = String((payload && payload.id) || '').trim()
      if (!/^\d{5}$/.test(id)) throw new RouteError('invalid', '被试编号应为 5 位数字')
      return subjectDetail(id)
    },
    async followup(payload) {
      const id = String((payload && payload.id) || '').trim()
      if (!/^\d{5}$/.test(id)) throw new RouteError('invalid', '被试编号应为 5 位数字')
      await saveFollowup(cfg, id, Boolean(payload && payload.done))
      cache = null
      return { id, done: Boolean(payload && payload.done) }
    },
    async schedule(payload) {
      const op = String((payload && payload.op) || 'add')
      if (op === 'remove') {
        const items = await removeSchedule(cfg, String((payload && payload.key) || ''))
        cache = null
        return { items }
      }
      const item = await addSchedule(cfg, payload || {})
      cache = null
      return item
    },
    async t0(payload) {
      const id = String((payload && payload.id) || '').trim()
      const date = String((payload && payload.date) || '').trim()
      if (!/^\d{5}$/.test(id)) throw new RouteError('invalid', '被试编号应为 5 位数字')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RouteError('invalid', '日期格式应为 YYYY-MM-DD')
      await saveT0(cfg, id, date)
      cache = null
      return { id, date }
    },
    async attendance(payload) {
      const key = String((payload && payload.key) || '').trim()
      if (!key) throw new RouteError('invalid', '缺少安排 key')
      const status = String((payload && payload.status) || '')
      await setAttendance(cfg, key, status)
      cache = null
      return { key, status }
    },
    async dismiss(payload) {
      const key = String((payload && payload.key) || '').trim()
      if (!key) throw new RouteError('invalid', '缺少异常 key')
      await dismissAnomaly(cfg, key, (payload && payload.note) || '')
      cache = null
      return { key }
    },
    async restore(payload) {
      await restoreAnomaly(cfg, String((payload && payload.key) || '').trim())
      cache = null
      return { ok: true }
    },
    async export() {
      const snap = await snapshot(false)
      const result = await exportReport(cfg, snap)
      return result
    },
    async reveal(payload) {
      const dir = path.resolve(String((payload && payload.dir) || path.join(cfg.stateDir, 'export')))
      await mkdir(dir, { recursive: true }).catch(() => {})
      const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
      child.unref()
      return { opened: dir }
    }
  }

  const handler = async (req, res) => {
    if (!sameOrigin(req) || req.headers[HEADER] !== '1') {
      send(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝跨站访问实验运行台接口' } })
      return
    }
    try {
      const url = new URL(req.url || ROUTE, 'http://localhost')
      if (req.method === 'GET') {
        const action = url.searchParams.get('action') || 'status'
        const run = actions[action]
        if (!run) throw new RouteError('unknown_action', '未知操作：' + action)
        const data = await run(Object.fromEntries(url.searchParams.entries()))
        send(res, 200, { ok: true, data })
        return
      }
      if (req.method !== 'POST') throw new RouteError('method', '只接受 GET 与 POST')
      const body = await readBody(req)
      const action = String(body.action || url.searchParams.get('action') || '')
      const run = actions[action]
      if (!run) throw new RouteError('unknown_action', '未知操作：' + action)
      const data = await run(body.payload || body || {})
      send(res, 200, { ok: true, data })
    } catch (error) {
      const status = error instanceof RouteError ? (error.code === 'not_found' ? 404 : 400) : 500
      if (status >= 500) console.error('[study-ops]', error)
      send(res, status, {
        ok: false,
        error: { code: error && error.code ? error.code : 'error', message: String(error && error.message ? error.message : error) }
      })
    }
  }

  const webServer = ctx.get ? ctx.get('webServer') : undefined
  if (webServer) {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'study-ops: http route')
  } else {
    ctx.inject(['webServer'], scope => {
      scope.effect(
        () => scope.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
        'study-ops: http route'
      )
    })
  }

  // Agent tool: same snapshot, no PII. Registered softly so a registry change
  // can never take the panel down with it.
  const registerTool = scope => {
    try {
      if (!scope.tools || typeof scope.tools.register !== 'function') return
      scope.tools.register({
        name: 'study_status',
        description: '查看 yyh 硕士论文实验的运行状态：入组进度、每位被试缺哪一次 DDT/IDM、数据质检异常、随访到期名单。只返回编号与计数，不含姓名和电话。',
        parameters: {
          type: 'object',
          properties: {
            focus: {
              type: 'string',
              enum: ['all', 'summary', 'anomalies', 'followup'],
              description: 'all=全部；summary=只看进度；anomalies=只看质控异常；followup=只看随访待办'
            }
          },
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false
          },
          render: (_args, value) => [{ type: 'text', text: value.text }]
        },
        async execute(args) {
          const snap = await snapshot(false)
          return { text: summaryText(snap, (args && args.focus) || 'all') }
        }
      })
      scope.tools.register({
        name: 'study_schedule',
        description: '管理实验施测安排：把某位被试在某天某个时间段加进安排，或删除已有安排。日期用 YYYY-MM-DD。',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'remove'], description: 'add=新增，remove=删除' },
            id: { type: 'string', description: '被试编号（5 位数字）' },
            date: { type: 'string', description: '日期 YYYY-MM-DD；add 必填，remove 时不填则删该编号全部安排' },
            start: { type: 'string', description: '开始时间，如 10:00' },
            end: { type: 'string', description: '结束时间，如 11:30' },
            note: { type: 'string', description: '备注' }
          },
          required: ['op', 'id'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false
          },
          render: (_args, value) => [{ type: 'text', text: value.text }]
        },
        async execute(args) {
          const id = String(args.id || '').trim()
          if (!/^\d{5}$/.test(id)) throw new Error('被试编号应为 5 位数字')
          if (args.op === 'remove') {
            await removeScheduleMatch(cfg, { id, date: args.date || '' })
            cache = null
            return { text: `已删除 ${id}${args.date ? ' 在 ' + args.date : ''} 的安排。` }
          }
          const item = await addSchedule(cfg, { id, date: args.date, start: args.start, end: args.end, note: args.note })
          cache = null
          const time = item.start ? item.start + (item.end ? '–' + item.end : '') : '时间未填'
          return { text: `已加入安排：${item.date} ${time} ${item.id}。` }
        }
      })
    } catch (error) {
      console.error('[study-ops] 工具注册失败：', error)
    }
  }
  const tools = ctx.get ? ctx.get('tools') : undefined
  if (tools) registerTool({ tools })
  else ctx.inject(['tools'], registerTool)
}

export const name = 'study-ops'
