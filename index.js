import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { loadStudyContext } from './study-context.mjs'
import { buildSnapshot, mutate, summaryText, exportReport } from './generic-scan.mjs'
import { hostBinding, bindingStatus, BindingError } from '../research-core/host.mjs'
import { openResearchData } from '../research-core/data.mjs'
import {
  scanMaterials, extractFindings, buildGaps, buildStudyDraft, assessReadiness,
  saveMaterialsIndex, loadMaterialsIndex, renderPrepReport, writeStudyDraft,
  diffStudyDraft, validateStudyDraft, loadCandidateDecisions, saveCandidateDecisions,
  setCandidateDecision, applyCandidateDecisions, findCandidate, summarizeDecisions,
  saveStudyDraftPreview, loadStudyDraftPreview, mergeStudyDraft, studyDefinitionRevision,
  candidateKey, candidateId,
} from '../research-core/materials.mjs'
import { openFlow } from '../research-core/flow.mjs'

const ROUTE = '/api/study-ops'
const VERSION = '0.3.1'
const READ_ACTIONS = new Set(['status', 'subject', 'capabilities', 'flowProjection'])
function send(res, status, payload) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.end(JSON.stringify(payload)) }
function body(req) { return new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', chunk => { size += chunk.length; if (size > 1048576) { reject(Object.assign(new Error('请求体过大'), { code: 'invalid' })); return } chunks.push(chunk) }); req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'invalid' })) } }); req.on('error', reject) }) }
const error = (message, code = 'invalid') => Object.assign(new Error(message), { code })
const statusFor = e => {
  const mapped = bindingStatus(e)
  if (mapped) return mapped
  if (e.code === 'forbidden') return 403
  if (e.code === 'not_found') return 404
  if (e.code === 'conflict') return 409
  if (['invalid', 'study_config'].includes(e.code)) return 400
  return 0
}
export { summaryText }

export function apply(ctx, config = {}) {
  let selectedPath = config.studyPath
  let switched = false
  let busy = 0
  let activeContext = loadStudyContext(runtimeConfig(), { pluginKey: 'ops' })
  function runtimeConfig() {
    return switched
      ? { ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}), projectRoot: config.projectRoot, studyPath: selectedPath }
      : { ...config, studyPath: selectedPath }
  }
  const context = () => activeContext

  const binding = hostBinding(ctx, {
    plugin: 'study-ops',
    version: VERSION,
    config,
    hooks: {
      loadStudy: studyPath => loadStudyContext({ studyPath }, { cwd: config.projectRoot, pluginKey: 'ops' }),
      currentIdentity: () => ({ studyId: activeContext.id, studyPath: activeContext.path, dataRoot: activeContext.dataRoot, revision: activeContext.revision }),
      busy: () => busy > 0,
      prepareSwitch(studyPath) {
        if (busy) throw error('运行台正在处理操作，请稍后切换', 'busy')
        const next = loadStudyContext({ studyPath }, { pluginKey: 'ops' })
        const candidate = next.plugin.adapterPath
        if (candidate && (!existsSync(candidate) || !statSync(candidate).isFile())) throw error('目标研究私有适配器不存在', 'study_config')
        if (candidate) { const manifest = candidate + '.json'; if (existsSync(manifest)) { const required = JSON.parse(readFileSync(manifest, 'utf8')).requiredConfig || []; for (const key of required) if (!next.plugin[key] && !(key === 'pythonPath' && config.pythonPath)) throw error('目标私有研究缺少配置：' + key, 'study_config') } }
        const previous = selectedPath
        const wasSwitched = switched
        const previousContext = activeContext
        return {
          commit() { selectedPath = studyPath; switched = true; activeContext = next; adapterPromise = null; adapterPath = null },
          rollback() { selectedPath = previous; switched = wasSwitched; activeContext = previousContext; adapterPromise = null; adapterPath = null }
        }
      }
    }
  })
  binding.dispatch(ctx)

  let adapterPromise, adapterPath
  async function engine() {
    const study = context()
    const configured = runtimeConfig().adapterPath || study.plugin.adapterPath
    if (!configured) return { study, snapshot: options => buildSnapshot(study, options), mutate: (action, payload) => mutate(study, action, payload), export: snap => exportReport(study, snap) }
    const resolved = path.resolve(study.baseDir, configured)
    if (adapterPath !== resolved) {
      adapterPath = resolved
      adapterPromise = import(pathToFileURL(resolved).href).then(module => {
        if (typeof module.createAdapter !== 'function') throw error('私有适配器需导出 createAdapter', 'study_config')
        return module
      })
    }
    const module = await adapterPromise
    const adapter = await module.createAdapter({ study, config: runtimeConfig() })
    if (!adapter || typeof adapter.snapshot !== 'function' || typeof adapter.mutate !== 'function') throw error('私有适配器接口不完整', 'study_config')
    return { ...adapter, study }
  }

  async function withFlow(actor, run) {
    const { binding: view } = await binding.read(actor, () => null)
    if (!view.configured) throw error('当前是空研究，没有数据根可写', 'study_config')
    return await run(flowFor(view), view)
  }

  /** 读操作：拿绑定 + 投影，不写任何东西。 */
  async function readFlow(actor, run) {
    const { binding: view } = await binding.read(actor, () => null)
    if (!view.configured) return { binding: view, data: null }
    return { binding: view, data: await run(flowFor(view), view) }
  }

  /** 用已解析的绑定直接开流程核心（不能放在写锁里再调 binding.read，会自等）。 */
  function flowFor(view) {
    const study = context()
    const data = openResearchData({ study, instanceId: view.instanceId })
    return openFlow({ data, study, owner: 'study-ops' })
  }
  function openFlowFor(view) { return flowFor(view) }

  /** 读操作：只解析绑定，不落写盘记录。 */
  async function readAction(name, payload) {
    const api = await engine()
    if (name === 'status') {
      const snap = await api.snapshot({ force: payload.forceQc === true || payload.forceQc === 'true' })
      return { ...snap, study: api.study.identity }
    }
    if (name === 'subject') {
      const snap = await api.snapshot()
      const subject = snap.subjects.find(s => s.id === payload.id)
      if (!subject) throw error('没有这个参与者', 'not_found')
      return { subject, study: api.study.identity }
    }
    throw error('未知操作：' + name)
  }

  /** 写操作：令牌已在研究核心里核对过，这里只做业务写入。 */
  async function writeAction(name, payload) {
    if (name === 'refresh') {
      const api = await engine()
      const snap = await api.snapshot({ force: payload.forceQc === true || payload.forceQc === 'true' })
      return { ...snap, study: api.study.identity }
    }
    const api = await engine()
    if (name === 'export') {
      const snap = await api.snapshot()
      return await (api.export ? api.export(snap) : exportReport(api.study, snap))
    }
    if (['schedule', 'attendance', 'followup', 'dismiss', 'restore'].includes(name)) return await api.mutate(name, payload)
    throw error('未知操作：' + name)
  }

  async function action(actor, name, payload = {}) {
    if (name === 'flowProjection') {
      const { binding: view, data } = await readFlow(actor, flow => flow.projection({ today: payload.today }))
      // 任务来源（如 {type:'scale',scaleId,waveId}）来自研究定义；投影里缺时用定义补齐，
      // 运行台据此才能"跳到量表波次"。
      if (data && Array.isArray(data.tasks)) {
        const defs = context().tasks || []
        data.tasks = data.tasks.map(task => {
          if (task.source) return task
          const def = defs.find(row => row.id === task.id)
          return def && def.source ? { ...task, source: def.source } : task
        })
      }
      return data ? { ...data, binding: view, study: context().identity } : { empty: true, binding: view, study: context().identity }
    }
    if (name === 'observationDetail' || name === 'flowParticipants') {
      const { binding: view, data } = await readFlow(actor, flow => {
        if (name === 'flowParticipants') {
          const rows = flow.participants.list()
          return { participants: rows.map(row => ({ participantId: row.participantId, participantKey: row.participantKey, status: row.status, groups: row.groups || {}, aliases: row.aliases || [] })) }
        }
        const query = { participantId: payload.participantId, participantKey: payload.participantKey, visitId: payload.visitId, taskId: payload.taskId }
        const effective = flow.observations.effective(query)
        const participant = payload.participantKey ? null : flow.participants.resolve(payload.participantId)
        return {
          ...effective,
          visitId: payload.visitId,
          taskId: payload.taskId,
          participant: participant ? { participantId: participant.participantId, participantKey: participant.participantKey, status: participant.status, groups: participant.groups || {} } : null,
        }
      })
      return data ? { ...data, binding: view, study: context().identity } : { empty: true, binding: view, study: context().identity }
    }
    if (name === 'observationAdjudicate' || name === 'observationCancel') {
      const expected = { token: payload.binding || payload.bindingToken, studyId: payload.studyId, studyRevision: payload.studyRevision }
      const { binding: view, data } = await binding.write(actor, expected, async resolvedView => {
        const flow = flowFor(resolvedView)
        const participant = flow.participants.resolve(payload.participantId)
        if (!participant) throw error('找不到参与者：' + (payload.participantId || ''), 'not_found')
        if (name === 'observationAdjudicate') {
          flow.observations.adjudicate({ participantKey: participant.participantKey, visitId: payload.visitId, taskId: payload.taskId, observationId: payload.observationId, reason: payload.reason })
        } else {
          flow.observations.cancelAdjudication({ participantKey: participant.participantKey, visitId: payload.visitId, taskId: payload.taskId })
        }
        const effective = flow.observations.effective({ participantKey: participant.participantKey, visitId: payload.visitId, taskId: payload.taskId })
        return { ...effective, participant: { participantId: participant.participantId, participantKey: participant.participantKey, status: participant.status, groups: participant.groups || {} }, visitId: payload.visitId, taskId: payload.taskId }
      })
      return { ...data, binding: view, study: context().identity }
    }
    if (name === 'followupMark') {
      const expected = { token: payload.binding || payload.bindingToken, studyId: payload.studyId, studyRevision: payload.studyRevision }
      const { binding: view, data } = await binding.write(actor, expected, async resolvedView => {
        const flow = flowFor(resolvedView)
        const participant = flow.participants.resolve(payload.participantId)
        if (!participant) throw error('找不到参与者：' + (payload.participantId || ''), 'not_found')
        flow.followups.mark({
          participantId: payload.participantId,
          followupId: payload.followupId,
          done: payload.done !== false,
          reason: payload.reason || (payload.done === false ? '运行台撤销标记' : '运行台人工标记'),
        })
        const projection = flow.projection({ today: payload.today })
        return { followups: projection.followups, followupCounts: projection.followupCounts, inputRevision: projection.inputRevision }
      })
      return { ...data, binding: view, study: context().identity }
    }
    if (name === 'studyConnect' || name === 'studyCreate') {
      const view = binding.connect(actor, name === 'studyCreate' ? { ...payload, create: true } : payload)
      const active = await binding.activate(actor)
      return { study: context().identity, binding: active, connected: view }
    }
    if (name === 'capabilities') {
      // 先把插件切到这个调用身份对应的研究，再报告各插件身份是否一致。
      await binding.read(actor, () => null)
      const capabilities = binding.capabilities(actor)
      return { ...capabilities, study: context().identity }
    }
    const expected = payload.binding || payload.bindingToken
      ? { token: payload.binding || payload.bindingToken, studyId: payload.studyId, studyRevision: payload.studyRevision }
      : { studyId: payload.studyId, studyRevision: payload.studyRevision }
    if (READ_ACTIONS.has(name)) {
      const { binding: view, data } = await binding.read(actor, async () => readAction(name, payload))
      return { ...data, binding: view, study: context().identity }
    }
    busy++
    try {
      const { binding: view, data } = await binding.write(actor, expected, async () => writeAction(name, payload))
      return { ...data, binding: view, study: context().identity }
    } finally { busy-- }
  }

  const handler = async (req, res) => {
    try {
      const site = String(req.headers['sec-fetch-site'] || '')
      if (req.headers['x-study-ops'] !== '1' || (site && !['same-origin', 'none'].includes(site))) throw error('拒绝跨站访问', 'forbidden')
      if (req.headers.origin) { let valid = false; try { valid = new URL(req.headers.origin).host === String(req.headers.host || '') } catch { /* 非法 origin */ } if (!valid) throw error('拒绝跨站访问', 'forbidden') }
      const url = new URL(req.url || ROUTE, 'http://localhost')
      let name, payload
      if (req.method === 'GET') {
        name = url.searchParams.get('action') || 'status'
        if (!['status', 'subject', 'capabilities', 'flowProjection'].includes(name)) throw error('写入和刷新操作请使用 POST')
        payload = Object.fromEntries(url.searchParams)
      } else if (req.method === 'POST') {
        const data = await body(req)
        name = String(data.action || '')
        payload = data.payload || {}
      } else throw error('只接受 GET 与 POST')
      const actor = binding.pageActor({ req, pageId: payload.pageId })
      send(res, 200, { ok: true, data: await action(actor, name, payload) })
    } catch (e) {
      const status = statusFor(e) || 500
      send(res, status, { ok: false, error: { code: e.code || 'error', message: String(e.message || e), details: e.details } })
    }
  }

  const server = ctx.get?.('webServer')
  if (server) ctx.effect(() => server.register({ kind: 'prefix', path: ROUTE, handler }), 'study-ops: route')
  else ctx.inject(['webServer'], scope => scope.effect(() => scope.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'study-ops: route'))

  const register = scope => {
    /* ---------- 04：参与者、observation、导入、随访与投影 ---------- */

    const textOut = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] }

    scope.tools?.register({
      name: 'participants_manage',
      description: '维护参与者索引：登记（registered，不自动入组）、状态变更（enrolled/exited/completed/screening_failed）、改号（保留旧号与历史）。编号始终按字符串处理。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['register', 'status', 'rename', 'list'] },
          participantId: { type: 'string' },
          status: { type: 'string', enum: ['registered', 'enrolled', 'exited', 'completed', 'screening_failed'] },
          groups: { type: 'object' },
          reason: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: textOut,
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const data = args || {}
        return await withFlow(actor, flow => {
          if (data.op === 'register') {
            flow.participants.register({ participantId: data.participantId, status: data.status, groups: data.groups, reason: data.reason })
            const row = flow.participants.resolve(data.participantId)
            return { text: `已登记/关联：${row.participantId}（${row.status}；key ${row.participantKey}）` }
          }
          if (data.op === 'status') {
            flow.participants.setStatus({ participantId: data.participantId, status: data.status, groups: data.groups, reason: data.reason })
            const row = flow.participants.resolve(data.participantId)
            return { text: `已更新：${row.participantId} → ${row.status}；历史 ${row.statusHistory.length} 条` }
          }
          if (data.op === 'rename') {
            flow.participants.rename({ from: data.from, to: data.to, reason: data.reason })
            const row = flow.participants.resolve(data.to)
            return { text: `已改号：${data.from} → ${row.participantId}；别名 ${(row.aliases || []).join('、') || '无'}` }
          }
          const rows = flow.participants.list()
          const counts = rows.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out }, {})
          return { text: `参与者 ${rows.length} 人：` + Object.entries(counts).map(([status, count]) => `${status} ${count}`).join('；') }
        })
      }
    })
    scope.tools?.register({
      name: 'observations_manage',
      description: '发布或裁决标准 observation：采集状态与质量状态分开；重复作答保留全部原值，裁决选一份并留理由，可撤销。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['publish', 'adjudicate', 'cancel'] },
          participantId: { type: 'string' },
          participantKey: { type: 'string' },
          visitId: { type: 'string' },
          taskId: { type: 'string' },
          recordId: { type: 'string' },
          observationId: { type: 'string' },
          collectionState: { type: 'string', enum: ['not_due', 'missing', 'received', 'entered', 'complete', 'conflict'] },
          qualityState: { type: 'string', enum: ['unchecked', 'valid', 'invalid', 'unscorable', 'unknown'] },
          eventDate: { type: 'string' },
          sourceType: { type: 'string' },
          sourceRevision: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: textOut,
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const data = args || {}
        return await withFlow(actor, flow => {
          if (data.op === 'publish') {
            flow.observations.publish({
              participantId: data.participantId, participantKey: data.participantKey,
              visitId: data.visitId, taskId: data.taskId, recordId: data.recordId,
              collectionState: data.collectionState, qualityState: data.qualityState,
              eventDate: data.eventDate, sourceType: data.sourceType || 'manual', sourceRevision: data.sourceRevision,
            })
            return { text: `已发布 observation：${data.participantId || data.participantKey} ${data.visitId}/${data.taskId}` }
          }
          const participant = data.participantKey ? null : flow.participants.resolve(data.participantId)
          const participantKey = data.participantKey || participant?.participantKey
          if (!participantKey) throw error('找不到参与者：' + (data.participantId || ''), 'not_found')
          if (data.op === 'adjudicate') {
            flow.observations.adjudicate({ participantKey, visitId: data.visitId, taskId: data.taskId, observationId: data.observationId, reason: data.reason })
            return { text: '已裁决并保留理由。' }
          }
          flow.observations.cancelAdjudication({ participantKey, visitId: data.visitId, taskId: data.taskId })
          return { text: '已撤销裁决，恢复为冲突状态。' }
        })
      }
    })
    /* 读取任务表：CSV/TSV 直接读；XLSX 用本机 Python（openpyxl）把第一个工作表转成 CSV。 */
    function defaultTaskPython() {
      const candidates = [
        config.pythonPath,
        process.env.DSH_MATERIALS_PYTHON,
        process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe') : '',
      ].filter(Boolean)
      return candidates.find(candidate => existsSync(candidate)) || ''
    }
    const XLSX_TO_CSV = [
      'import sys, csv, openpyxl',
      'wb = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True)',
      'ws = wb[wb.sheetnames[0]]',
      'writer = csv.writer(sys.stdout, lineterminator="\\n")',
      'for row in ws.iter_rows(values_only=True):',
      '    cells = ["" if value is None else str(value) for value in row]',
      '    if any(cell != "" for cell in cells):',
      '        writer.writerow(cells)',
    ].join('\n')
    function readTaskTable(file) {
      const absolute = path.resolve(file)
      if (!existsSync(absolute)) throw error('文件不存在：' + file, 'not_found')
      const extension = path.extname(absolute).toLowerCase()
      const bytes = readFileSync(absolute)
      const sourceHash = createHash('sha256').update(bytes).digest('hex')
      const filename = path.basename(absolute)
      if (['.csv', '.tsv', '.txt'].includes(extension)) {
        return { filename, text: bytes.toString('utf8'), sourceHash, sourcePath: absolute }
      }
      if (!['.xlsx', '.xlsm', '.xltx'].includes(extension)) throw error('只支持 CSV/TSV 与 XLSX（旧版 .xls 请另存为 .xlsx）', 'unsupported')
      const python = defaultTaskPython()
      if (!python) throw error('读 XLSX 需要本机 Python（openpyxl）：请在插件配置里给 pythonPath，或设置 DSH_MATERIALS_PYTHON', 'study_config')
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
      const pdfLibDir = process.env.DSH_PDF_LIBS || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'pdf-libs') : '')
      if (pdfLibDir && existsSync(pdfLibDir)) env.PYTHONPATH = [pdfLibDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      const run = spawnSync(python, ['-X', 'utf8', '-c', XLSX_TO_CSV, absolute], { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, env })
      if (run.error) throw error('XLSX 解析失败：' + run.error.message, 'study_config')
      if (run.status !== 0) throw error('XLSX 解析失败：' + String(run.stderr || '').trim().slice(0, 300), 'invalid')
      if (!String(run.stdout || '').trim()) throw error('XLSX 第一个工作表是空的', 'invalid')
      return { filename, text: run.stdout, sourceHash, sourcePath: absolute }
    }
    scope.tools?.register({
      name: 'task_import',
      description: '导入电脑任务 CSV/TSV/XLSX：preview 显示列映射与预览；commit 发布为 observation，原始文件登记 hash 并可归档副本。相同内容重复导入幂等，同名不同内容成为新来源版本。XLSX 用本机 Python（openpyxl）读第一个工作表。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['preview', 'commit'] },
          path: { type: 'string', description: 'CSV/TSV/XLSX 文件绝对路径（或相对会话目录）' },
          text: { type: 'string', description: '也可直接给内容（CSV/TSV）' },
          mapping: { type: 'object' },
          archiveDir: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: textOut,
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const data = args || {}
        let table = null
        const content = typeof data.text === 'string' ? data.text : (() => {
          if (!data.path) throw error('请给出 CSV/TSV/XLSX 路径或内容', 'invalid')
          const target = path.isAbsolute(data.path) ? data.path : path.join(binding.sessionCwd(actor.sessionId || '') || process.cwd(), data.path)
          table = readTaskTable(target)
          return table.text
        })()
        const filename = table ? table.filename : (data.path ? path.basename(data.path) : 'import.csv')
        const digest = table ? table.sourceHash : undefined
        const sourcePath = table ? table.sourcePath : undefined
        return await withFlow(actor, (flow, view) => {
          if (data.op === 'preview') {
            const preview = flow.imports.preview({ filename, text: content, mapping: data.mapping, sourceHash: digest })
            const lines = [
              `文件：${filename}（${preview.totalRows} 行，sha256 ${preview.sha256.slice(0, 12)}）`,
              `列映射：` + Object.entries(preview.mapping).map(([role, header]) => `${role}=${header}`).join('，'),
              preview.missing.length ? `缺少必要列：${preview.missing.join('、')}` : '必要列齐全。',
              preview.idempotent ? '相同内容已导入过（提交会幂等跳过）。' : `将作为第 ${preview.newSourceRevision} 个来源版本提交。`,
              preview.sameFilenameOtherContent.length ? `同名文件已有 ${preview.sameFilenameOtherContent.length} 个版本（hash 不同）。` : '',
              '预览：' + preview.preview.slice(0, 5).map(row => `${row.id} ${row.visit}/${row.task} ${row.eventDate || '日期未知'}`).join('；'),
              preview.problems.length ? `问题：${preview.problems.slice(0, 5).map(row => `第${row.row}行 ${row.text}`).join('；')}` : '',
            ].filter(Boolean)
            return { text: lines.join('\n') }
          }
          const archiveDir = data.archiveDir || path.join(view.dataRoot, 'tasks', 'archive')
          const result = flow.imports.commit({ filename, text: content, mapping: data.mapping, archiveDir, sourceHash: digest, sourcePath })
          return { text: result.idempotent ? '相同内容已导入过，未重复累计。' : `已导入：发布 ${result.observations} 条 observation，跳过 ${result.skipped} 条（编号不在索引里）。${result.notes.join('；')}` }
        })
      }
    })
    scope.tools?.register({
      name: 'followup_manage',
      description: '查看随访到期与完成情况，或人工标记完成（保留理由）。锚点取所有必需且适用任务唯一完成的最晚有效日期。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'mark'] },
          participantId: { type: 'string' },
          followupId: { type: 'string' },
          done: { type: 'boolean' },
          reason: { type: 'string' },
          today: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: textOut,
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const data = args || {}
        return await withFlow(actor, flow => {
          if (data.op === 'mark') {
            flow.followups.mark({ participantId: data.participantId, followupId: data.followupId, done: data.done !== false, reason: data.reason })
            return { text: `已记录随访完成：${data.participantId} / ${data.followupId}` }
          }
          const rows = flow.followups.compute({ today: data.today })
          const counts = rows.reduce((out, row) => { out[row.state] = (out[row.state] || 0) + 1; return out }, {})
          const lines = [`随访 ${rows.length} 条：` + Object.entries(counts).map(([state, count]) => `${state} ${count}`).join('；')]
          for (const row of rows.filter(item => item.state === 'due' || item.state === 'overdue').slice(0, 10)) {
            lines.push(`- ${row.participantId} ${row.label}：到期 ${row.dueAt || '未知'}（${row.state}${row.daysFromDue !== null ? `，偏差 ${row.daysFromDue} 天` : ''}）`)
          }
          return { text: lines.join('\n') }
        })
      }
    })
    scope.tools?.register({
      name: 'flow_projection',
      description: '运行台投影：总人数与入组、性别（男/女/其他/未知/缺失）、分组卡片、任务状态汇总、异常与随访计数、来源健康。默认不返回逐人明细。',
      parameters: {
        type: 'object',
        properties: {
          today: { type: 'string' },
          focus: { type: 'string', enum: ['all', 'groups', 'matrix', 'anomalies', 'sources'] },
        },
        additionalProperties: false,
      },
      output: textOut,
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const data = args || {}
        return await withFlow(actor, flow => {
          const projection = flow.projection({ today: data.today })
          const focus = data.focus || 'all'
          const lines = []
          lines.push(`研究：${projection.study.name}（今天 ${projection.today}，输入版本 ${projection.inputRevision.slice(0, 12)}）`)
          lines.push(`人数：参与者 ${projection.totals.participants}，已入组 ${projection.totals.enrolled}，已登记未入组 ${projection.totals.registered}，退出 ${projection.totals.exited}，完成 ${projection.totals.completed}，筛查失败 ${projection.totals.screeningFailed}`)
          lines.push(`性别（已入组 ${projection.totals.enrolled} 人）：男 ${projection.sex.male}，女 ${projection.sex.female}，其他 ${projection.sex.other}，未知 ${projection.sex.unknown}，缺失 ${projection.sex.missing}${projection.sex.mapped ? '' : '（' + projection.sex.note + '）'}`)
          if (focus === 'all' || focus === 'groups') {
            lines.push(`分组 ${projection.groups.length} 个：`)
            for (const group of projection.groups.slice(0, 12)) lines.push(`- ${group.group}：已入组 ${group.enrolled}；男 ${group.sex.male} 女 ${group.sex.female} 其他 ${group.sex.other} 未知 ${group.sex.unknown} 缺失 ${group.sex.missing}`)
          }
          if (focus === 'all' || focus === 'matrix') {
            const counts = {}
            for (const row of projection.matrix) for (const slot of Object.values(row.slots)) counts[slot.collection] = (counts[slot.collection] || 0) + 1
            lines.push(`任务声明 ${projection.tasks.length} 个；状态分布：` + (Object.entries(counts).map(([state, count]) => `${state} ${count}`).join('；') || '还没有参与者或记录'))
            const quality = {}
            for (const row of projection.matrix) for (const slot of Object.values(row.slots)) quality[slot.quality] = (quality[slot.quality] || 0) + 1
            lines.push('质量状态分布：' + (Object.entries(quality).map(([state, count]) => `${state} ${count}`).join('；') || '无'))
          }
          if (focus === 'all' || focus === 'anomalies') {
            const byTask = {}
            for (const row of projection.anomalies) { byTask[row.taskId] = (byTask[row.taskId] || 0) + 1 }
            lines.push(`异常 ${projection.anomalies.length} 条` + (projection.anomalies.length ? '：' + Object.entries(byTask).map(([task, count]) => `${task} ${count}`).join('；') : ''))
            for (const row of projection.anomalies.slice(0, 10)) lines.push(`- [${row.level}] ${row.participantId} ${row.visitId}/${row.taskId}：${row.text}`)
          }
          lines.push(`随访：到期 ${projection.followupCounts.due}，逾期 ${projection.followupCounts.overdue}，未知 ${projection.followupCounts.unknown}，完成 ${projection.followupCounts.done}`)
          if (focus === 'all' || focus === 'sources') {
            lines.push('来源：' + Object.entries(projection.sources).map(([name, health]) => {
              const legacy = health.legacy && !(health.committed && health.committed.revision) && health.legacy.state !== 'missing'
                ? `，旧文件 ${health.legacy.state}${health.legacy.bytes ? ` ${health.legacy.bytes} 字节` : ''}`
                : ''
              return `${name} ${health.state}${legacy}`
            }).join('；'))
          }
          return { text: lines.join('\n') }
        })
      }
    })

    /* ---------- 03：材料接入与实验准备 ---------- */

    function defaultRuntimePython() {
      const home = process.env.DSH_HOME
      if (!home) return ''
      const candidate = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
      return existsSync(candidate) ? candidate : ''
    }
    const materialsPython = () => ({
      pythonPath: process.env.DSH_MATERIALS_PYTHON || context().plugin.pythonPath || config.pythonPath || defaultRuntimePython(),
      pdfLibDir: process.env.DSH_PDF_LIBS || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'pdf-libs') : ''),
      timeoutMs: 30000,
    })
    function materialsRoot(actor, explicit) {
      const cwd = binding.sessionCwd(actor.sessionId || '') || process.cwd()
      if (!explicit) return cwd
      return path.isAbsolute(explicit) ? explicit : path.join(cwd, explicit)
    }
    /** 准备度按阶段使用真实配置：统计后端来自插件/研究配置，演练状态来自配置。 */
    function materialsReadinessOptions() {
      const plugin = context()?.plugin || {}
      return {
        python: materialsPython(),
        statisticsBackend: config.statisticsBackend || plugin.statisticsBackend,
        dryRun: config.dryRun || plugin.dryRun,
      }
    }
    const indexDirFor = root => path.join(root, '.dsh-materials')
    function readDraftIfAny(root) {
      const candidate = path.join(root, 'study.json')
      try { return existsSync(candidate) ? JSON.parse(readFileSync(candidate, 'utf8')) : null } catch { return null }
    }
    function materialSummary(inventory, findings, readiness) {
      const coverage = inventory.coverage || {}
      const lines = []
      lines.push(`材料目录：${inventory.root}`)
      lines.push(`扫描：${coverage.files || 0} 个文件（解析 ${coverage.parsed || 0}，需要 OCR ${coverage.needsOcr || 0}，未解析 ${coverage.unparsed || 0}，失败 ${coverage.failed || 0}；覆盖率 ${Math.round((coverage.coverageRatio || 0) * 100)}%，分母含未尝试 ${coverage.notScanned || 0} 个；复用 ${inventory.reused || 0} 个未变文件）`)
      lines.push(`扫描完整性：${coverage.complete === false ? '不完整（' + ((coverage.incompleteReasons || []).join('、') || '未知原因') + '）' : '完整'}${coverage.complete === false ? '；上一轮已知但本轮未遍历的文件标为 not_scanned，不判 removed' : ''}`)
      const blockers = readiness.blockers || []
      lines.push(`阻断项 ${blockers.length} 项` + (blockers.length ? '：' + blockers.slice(0, 6).map(row => `[${row.category}] ${row.text}`).join('；') : ''))
      const pending = readiness.pending || []
      lines.push(`待核实 ${pending.length} 项` + (pending.length ? '：' + pending.slice(0, 6).map(row => row.text).join('；') : ''))
      const groups = new Map()
      for (const candidate of findings.candidates || []) groups.set(candidate.kind, (groups.get(candidate.kind) || 0) + 1)
      lines.push('已识别：' + ([...groups].map(([kind, count]) => `${kind} ${count}`).join('；') || '无'))
      const decisions = summarizeDecisions(findings.candidates || [])
      lines.push(`候选决定：已确认 ${decisions.accepted}，已拒绝 ${decisions.rejected}，待映射 ${decisions.pending_mapping}，待确认 ${decisions.pending}，需复核 ${decisions.needs_review}`)
      if (findings.conflicts?.length) lines.push(`冲突 ${findings.conflicts.length} 项（未批准）：` + findings.conflicts.map(row => row.label).join('；'))
      lines.push(`可疑指令内容 ${findings.instructionLike?.length || 0} 条（只作资料解析，不执行、不外传）`)
      lines.push(`索引：${indexDirFor(inventory.root)}/index`)
      return lines.join('\n')
    }
    function loadIndexOrThrow(root) {
      const index = loadMaterialsIndex(indexDirFor(root))
      if (!index.inventory) throw error('还没有扫描结果，请先运行 materials_scan', 'not_found')
      return index
    }

    scope.tools?.register({
      name: 'materials_scan',
      description: '扫描材料目录并保存派生索引：清单、解析状态、覆盖率、候选、冲突与缺项。只读材料、不联网、不移动文件；本地解析失败会明确列为未覆盖。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '材料目录；省略则用会话当前目录' }, retry: { type: 'boolean', description: '强制重解析失败/未解析文件（环境补齐后使用）' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const root = materialsRoot(actor, args?.path)
        if (!existsSync(root)) throw error('材料目录不存在：' + root, 'not_found')
        const indexDir = indexDirFor(root)
        const previous = loadMaterialsIndex(indexDir).inventory
        const inventory = await scanMaterials({ root, previous, python: materialsPython(), maxFiles: 2000, maxDepth: 6, timeoutMs: 60000, retryUnparsed: args?.retry === true })
        // 重新扫描按来源指纹保留仍有效的人工决定；来源变化只标 needs_review，不静默忘记。
        const decisions = loadCandidateDecisions(indexDir)
        let findings = extractFindings(inventory)
        findings = applyCandidateDecisions(findings, decisions)
        findings.gaps = buildGaps(findings)
        const draft = readDraftIfAny(root)
        const readiness = await assessReadiness({ inventory, findings, draft, ...materialsReadinessOptions() })
        saveMaterialsIndex({ dir: indexDir, inventory, findings, readiness, report: renderPrepReport({ inventory, findings, readiness }) })
        return { text: materialSummary(inventory, findings, readiness) }
      }
    })
    scope.tools?.register({
      name: 'prep_readiness',
      description: '查看材料接入与实验准备度：材料覆盖、配置草案、统计环境、演练四块分别判定，并列出阻断项与待核实项。不返回逐人数据。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '材料目录；省略则用会话当前目录' }, focus: { type: 'string', enum: ['all', 'blockers', 'pending'] } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const root = materialsRoot(actor, args?.path)
        const index = loadIndexOrThrow(root)
        const draft = readDraftIfAny(root)
        const readiness = await assessReadiness({ inventory: index.inventory, findings: index.findings, draft, ...materialsReadinessOptions() })
        const focus = args?.focus || 'all'
        const lines = []
        for (const [area, value] of Object.entries(readiness.areas)) lines.push(`- ${area}：${value.state}`)
        for (const [stage, value] of Object.entries(readiness.stages || {})) {
          const reason = (value.blockers || []).map(row => row.text).join('；')
          lines.push(`- 阶段 ${stage}：${value.state}${reason ? `（阻断：${reason}）` : ''}`)
        }
        lines.push(`可以开始：${readiness.canStart ? '是' : '否'}`)
        if (focus !== 'pending') {
          lines.push(`阻断项 ${readiness.blockers.length} 项`)
          for (const row of readiness.blockers.slice(0, 10)) lines.push(`- [${row.category}] ${row.text}`)
        }
        if (focus !== 'blockers') {
          lines.push(`待核实 ${readiness.pending.length} 项`)
          for (const row of readiness.pending.slice(0, 10)) lines.push(`- [${row.kind}] ${row.text}`)
        }
        return { text: lines.join('\n') }
      }
    })
    scope.tools?.register({
      name: 'materials_decisions',
      description: '查看或设置材料候选的确认/拒绝/待映射状态。决定持久化在派生索引里；重新扫描按来源指纹保留，来源变化只标 needs_review。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '材料目录；省略则用会话当前目录' },
          op: { type: 'string', enum: ['list', 'set'] },
          candidateKey: { type: 'string', description: '候选键（list 输出）' },
          candidateId: { type: 'string', description: '候选短 ID（list 输出）' },
          kind: { type: 'string' },
          label: { type: 'string' },
          decision: { type: 'string', enum: ['accepted', 'rejected', 'pending_mapping'] },
          reason: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const root = materialsRoot(actor, args?.path)
        const indexDir = indexDirFor(root)
        const index = loadIndexOrThrow(root)
        if ((args?.op || 'list') === 'list') {
          const findings = index.findings || {}
          const summary = summarizeDecisions(findings.candidates || [])
          const lines = [`候选决定：已确认 ${summary.accepted}，已拒绝 ${summary.rejected}，待映射 ${summary.pending_mapping}，待确认 ${summary.pending}，需复核 ${summary.needs_review}`]
          for (const candidate of (findings.candidates || []).slice(0, 20)) lines.push(`- ${candidateId(candidate)} ${candidate.kind}「${candidate.label}」→ ${candidate.decision || 'pending'}${candidate.confirmed ? '（已确认）' : ''}`)
          if ((findings.staleDecisions || []).length) lines.push(`需要复核的人工决定 ${findings.staleDecisions.length} 项：` + findings.staleDecisions.slice(0, 8).map(row => row.label).join('；'))
          return { text: lines.join('\n') }
        }
        const candidate = findCandidate(index.findings, { candidateKey: args?.candidateKey, candidateId: args?.candidateId, kind: args?.kind, label: args?.label })
        if (!candidate) throw error('没有这个候选；请先 materials_scan，或用 candidateKey / candidateId 指定', 'not_found')
        const document = loadCandidateDecisions(indexDir)
        const nextDocument = setCandidateDecision(document, { candidate, decision: args?.decision, reason: args?.reason })
        saveCandidateDecisions(indexDir, nextDocument)
        let findings = applyCandidateDecisions(index.findings, nextDocument)
        findings.gaps = buildGaps(findings)
        const draft = readDraftIfAny(root)
        const readiness = await assessReadiness({ inventory: index.inventory, findings, draft, ...materialsReadinessOptions() })
        saveMaterialsIndex({ dir: indexDir, inventory: index.inventory, findings, readiness, report: renderPrepReport({ inventory: index.inventory, findings, readiness }) })
        const entry = nextDocument.decisions[candidateKey(candidate)]
        return { text: `已记录候选决定：${candidate.kind}「${candidate.label}」→ ${entry.decision}${entry.reason ? '（理由：' + entry.reason + '）' : ''}\n候选决定：` + JSON.stringify(summarizeDecisions(findings.candidates)) }
      }
    })
    scope.tools?.register({
      name: 'study_draft_preview',
      description: '从已扫描的候选生成研究配置草案并预览 diff：已确认与待确认的候选会进入预览，拒绝/待映射的候选排除，不自动批准计分冲突。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '材料目录；省略则用会话当前目录' }, draftPath: { type: 'string', description: '已有研究定义路径，用于预览 diff' }, name: { type: 'string' }, studyId: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const root = materialsRoot(actor, args?.path)
        const index = loadIndexOrThrow(root)
        let draft = buildStudyDraft({ findings: index.findings, root, studyId: args?.studyId, name: args?.name })
        const draftPath = args?.draftPath ? String(args.draftPath) : ''
        const baseRevision = draftPath && existsSync(draftPath) ? studyDefinitionRevision(readFileSync(draftPath, 'utf8')) : null
        let removed = []
        const lines = []
        if (baseRevision) {
          try {
            const current = JSON.parse(readFileSync(draftPath, 'utf8'))
            const merged = mergeStudyDraft(current, draft)
            draft = merged.draft
            removed = merged.removed
            const rows = diffStudyDraft(current, draft)
            lines.push(`与现有定义的差异 ${rows.length} 处` + (rows.length ? '：' + rows.slice(0, 10).map(row => row.path).join('；') : ''))
            if (removed.length) lines.push(`草案没有提到、更新时会保留的行 ${removed.length} 项：` + removed.slice(0, 10).map(row => `${row.kind}:${row.id}`).join('；'))
            if (merged.kept.length) lines.push(`保留的已有配置：${merged.kept.join('、')}`)
          } catch (failure) { lines.push('现有定义读不了：' + failure.message) }
        }
        const preview = saveStudyDraftPreview({ dir: indexDirFor(root), draft, baseRevision, targetPath: draftPath || null, removed })
        const problems = validateStudyDraft(draft)
        const decisions = summarizeDecisions(index.findings?.candidates || [])
        const head = [
          `预览 ID：${preview.draftId}`,
          `内容版本：${preview.revision}`,
          `草案：${draft.name}（${draft.studyId}）`,
          `访视 ${draft.visits.length} 个；任务 ${draft.tasks.length} 个；编号样例 ${draft.participantId?.pattern || '无'}`,
          `候选决定：已确认 ${decisions.accepted}，待确认 ${decisions.pending}，待映射 ${decisions.pending_mapping}，需复核 ${decisions.needs_review}`,
        ]
        if (problems.length) head.push('草案问题：' + problems.join('；'))
        const text = [...head, ...lines, '', JSON.stringify(draft, null, 2)].join('\n')
        return { text }
      }
    })
    scope.tools?.register({
      name: 'study_draft_save',
      description: '保存研究配置草案：默认独占创建；可用预览返回的 draftId + expectedRevision 保存同一内容；更新以现有定义为基准合并，不覆盖未知变更、不清空 plugins/路径/编号规则。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '材料目录；省略则用会话当前目录' },
          draftPath: { type: 'string', description: '研究定义要写到的绝对路径' },
          mode: { type: 'string', enum: ['create', 'update'] },
          draftId: { type: 'string', description: 'study_draft_preview 返回的预览 ID' },
          expectedRevision: { type: 'string' },
          name: { type: 'string' },
          studyId: { type: 'string' },
        },
        required: ['draftPath'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const root = materialsRoot(actor, args?.path)
        const index = loadIndexOrThrow(root)
        const draftPath = String(args?.draftPath || '')
        if (!path.isAbsolute(draftPath)) throw error('研究定义需要绝对路径', 'invalid')
        const mode = args?.mode || 'create'
        const indexDir = indexDirFor(root)
        const preview = args?.draftId ? loadStudyDraftPreview(indexDir, String(args.draftId)) : null
        if (args?.draftId && !preview) throw error('预览不存在或已过期，请重新预览：' + args.draftId, 'not_found')
        if (preview?.targetPath && path.resolve(preview.targetPath) !== path.resolve(draftPath)) throw error('预览写的是另一个研究定义，请重新预览', 'dataset_conflict')
        if (preview && args?.expectedRevision && args.expectedRevision !== preview.revision) throw error('预览内容已变化（expectedRevision 不匹配），请重新预览', 'dataset_conflict')
        let draft
        let removed = []
        let fileRevision
        if (preview) {
          draft = preview.draft
          removed = Array.isArray(preview.removed) ? preview.removed : []
          if (mode !== 'create' && existsSync(draftPath)) {
            const existingText = readFileSync(draftPath, 'utf8')
            if (!preview.baseRevision || studyDefinitionRevision(existingText) !== preview.baseRevision) throw error('研究定义在预览后已被改动，请重新预览', 'dataset_conflict')
            fileRevision = preview.baseRevision
          }
        } else {
          draft = buildStudyDraft({ findings: index.findings, root, studyId: args?.studyId, name: args?.name })
          if (mode !== 'create' && existsSync(draftPath)) {
            try {
              const current = JSON.parse(readFileSync(draftPath, 'utf8'))
              const merged = mergeStudyDraft(current, draft)
              draft = merged.draft
              removed = merged.removed
            } catch (failure) { throw error('现有研究定义读不了：' + failure.message, 'dataset_conflict') }
            fileRevision = args?.expectedRevision
          }
        }
        const result = writeStudyDraft({ path: draftPath, draft, mode, expectedRevision: mode === 'create' ? undefined : fileRevision })
        const problems = validateStudyDraft(draft)
        const lines = [
          `${result.created ? '已创建' : '已更新'}研究定义：${result.path}`,
          `revision：${result.revision}`,
        ]
        if (preview) lines.push(`预览 ID：${preview.draftId}`)
        if (removed.length) lines.push(`保留的已有行 ${removed.length} 项（未删除）：` + removed.slice(0, 10).map(row => `${row.kind}:${row.id}`).join('；'))
        lines.push(problems.length ? '注意：草案仍有问题：' + problems.join('；') : '草案校验通过。')
        lines.push('下一步：用 studyConnect 连接这个研究（需要绝对路径），连接只影响当前页面或会话。')
        return { text: lines.join('\n') }
      }
    })

    scope.tools?.register({
      name: 'study_binding',
      description: '查看当前会话绑定的研究身份与位置：解析来源、实例、研究定义路径、各插件是否一致。不返回逐人数据。',
      parameters: { type: 'object', properties: { focus: { type: 'string', enum: ['all', 'plugins', 'candidates'] } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const view = await action(binding.agentActor(exec), 'capabilities')
        const focus = args?.focus || 'all'
        const current = view.binding || {}
        const sessionCwd = exec?.agent?.id ? binding.sessionCwd(String(exec.agent.id)) : null
        const lines = [
          `研究：${current.name || '（未命名）'}（${current.studyId || '无 studyId'}）`,
          `绑定：${current.state || '未知'} · 来源 ${current.source || '未知'} · 实例 ${String(current.instanceId || '').slice(0, 16)} · 版本 ${current.bindingRevision ?? 0}`,
          `定义：${current.studyPath || '无研究定义（空研究）'}`,
          `数据根：${current.dataRoot || '—'}`,
          `会话目录：${sessionCwd || '（无会话身份）'} · 项目配置：${view.candidates?.projectConfig || '未发现'} · 适配层 ${view.core?.hostVersion || '未知'}`
        ]
        if (focus !== 'plugins') {
          const studies = view.candidates?.studies || []
          lines.push(`候选研究 ${studies.length} 个` + (studies.length ? '：' + studies.slice(0, 8).map(row => `${row.label || row.studyId}${row.exists === false ? '（文件缺失）' : ''}`).join('；') : ''))
        }
        if (focus !== 'candidates') {
          lines.push('插件一致性：' + (view.consistent ? '一致' : '不一致'))
          for (const row of view.plugins || []) lines.push(`- ${row.name} ${row.version || ''}：${row.current?.studyId || '未加载'}${row.matchesBinding === false ? '（与绑定不一致）' : ''}`)
        }
        return { text: lines.join('\n') }
      }
    })
    scope.tools?.register({
      name: 'study_data_health',
      description: '查看当前研究的各数据集健康：已提交代次（数据核心）与兼容平面文件的状态、大小与版本。只返回状态与计数，不返回逐人数据。',
      parameters: { type: 'object', properties: { dataset: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const { binding: view } = await binding.read(actor, () => null)
        if (!view.configured) return { text: '当前是空研究（没有研究定义），没有数据根可检查。' }
        const data = openResearchData({ study: context(), instanceId: view.instanceId })
        const only = args && args.dataset ? String(args.dataset) : ''
        const rows = data.health().filter(row => !only || row.dataset === only)
        const stateLabel = { ok: '正常', empty: '尚未录入', missing: '文件不存在', invalid: '损坏', unreadable: '读不了', conflict: '代次冲突', unconfigured: '未配置' }
        const lines = [`数据根：${data.root}（实例 ${view.instanceId}）`]
        for (const row of rows) {
          const label = row.committed.revision
            ? `已提交 v${row.committed.revision}`
            : (row.legacy && row.legacy.state === 'ok' ? '仅有兼容文件（未迁移）' : (stateLabel[row.state] || row.state))
          const legacy = row.legacy ? `兼容文件 ${stateLabel[row.legacy.state] || row.legacy.state}${row.legacy.bytes ? ` ${row.legacy.bytes} 字节` : ''}` : ''
          lines.push(`- ${row.dataset}：${label}；${legacy}`)
        }
        lines.push('说明：已提交代次来自数据核心（权威），兼容平面文件只用于迁移核对。')
        return { text: lines.join('\n') }
      }
    })
    scope.tools?.register({
      name: 'study_status',
      description: '查看当前研究的参与者进度、数据来源健康、异常与随访。只返回编号与计数。',
      parameters: { type: 'object', properties: { focus: { type: 'string', enum: ['all', 'summary', 'anomalies', 'followup'] } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const actor = binding.agentActor(exec)
        const snap = await action(actor, 'status')
        const text = summaryText(snap, args?.focus || 'all')
        // 附一行"已提交版本"摘要：与运行台页面同一份核心投影，避免工具和界面各说各的。
        let core = ''
        try {
          const { data } = await readFlow(actor, flow => flow.projection({ today: args?.today }))
          if (data) {
            const totals = data.totals || {}
            if ((totals.participants || 0) === 0) {
              const legacy = Object.values(data.sources || {}).reduce((sum, health) => sum + ((health && health.legacy && health.legacy.state === 'ok' && health.legacy.bytes) || 0), 0)
              core = legacy > 0 ? `核心：尚未开始（旧文件 ${Math.round(legacy / 1024)} KB 未迁移）` : '核心：尚无已提交记录'
            } else {
              const sex = data.sex || {}
              core = `核心：入组 ${totals.enrolled || 0} / 参与者 ${totals.participants || 0}，男 ${sex.male || 0} 女 ${sex.female || 0} 其他 ${sex.other || 0} 未知 ${sex.unknown || 0} 缺失 ${sex.missing || 0}（来源版本 ${String(data.inputRevision || '').slice(0, 8)}）`
            }
          }
        } catch (error) {
          core = `核心：读取失败（${error && error.message ? error.message : error}）`
        }
        return { text: core ? `${text}\n${core}` : text }
      }
    })
    scope.tools?.register({
      name: 'study_schedule',
      description: '为当前研究添加或删除访视预约。先取得状态版本；日期 YYYY-MM-DD。',
      parameters: { type: 'object', properties: { op: { type: 'string', enum: ['add', 'remove'] }, id: { type: 'string' }, visitId: { type: 'string' }, date: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, resource: { type: 'string' }, note: { type: 'string' }, key: { type: 'string' }, stateRevision: { type: 'integer' } }, required: ['op', 'stateRevision'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        const data = await action(binding.agentActor(exec), 'schedule', { ...args })
        return { text: JSON.stringify(data) }
      }
    })
  }
  const tools = ctx.get?.('tools')
  if (tools) register({ tools })
  else ctx.inject(['tools'], register)
}
export const name = 'study-ops'
export const version = VERSION
