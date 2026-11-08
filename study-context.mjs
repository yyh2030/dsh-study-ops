import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const label = value => typeof value === 'string' ? value.trim() : ''

export class StudyConfigError extends Error {
  constructor(message) { super(message); this.name = 'StudyConfigError'; this.code = 'study_config' }
}

export function resolveStudyPath(base, value) {
  if (!label(value)) return null
  return path.resolve(base, value)
}

/** Validates the original document without creating directories or changing it. */
export function validateStudyDefinition(raw) {
  const problems = []
  if (!object(raw)) return ['研究定义必须是JSON对象']
  if (raw.schemaVersion !== 1) problems.push('研究schemaVersion必须为1')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(label(raw.studyId))) problems.push('studyId需为1–80个字母、数字、点、下划线或连字符')
  if (!label(raw.name)) problems.push('研究名称不能为空')
  if (raw.participantId !== undefined && !object(raw.participantId)) problems.push('participantId需为对象')
  if (raw.participantId?.pattern !== undefined && typeof raw.participantId.pattern !== 'string') problems.push('参与者编号pattern需为字符串')
  if (typeof raw.participantId?.pattern === 'string' && raw.participantId.pattern) {
    try { new RegExp(raw.participantId.pattern, 'u') } catch { problems.push('参与者编号pattern不是合法正则') }
  }
  if (raw.dataRoot !== undefined && !label(raw.dataRoot)) problems.push('dataRoot需为非空路径字符串')
  if (raw.participants !== undefined && !object(raw.participants)) problems.push('participants需为对象')
  const keys = {}
  for (const kind of ['visits', 'tasks', 'followups']) {
    if (raw[kind] !== undefined && !Array.isArray(raw[kind])) { problems.push(`${kind}需为数组`); continue }
    const found = new Set()
    for (const row of raw[kind] || []) {
      if (!object(row) || !label(row.id)) { problems.push(`${kind}中每项需有非空id`); continue }
      if (row.id !== row.id.trim()) problems.push(`${kind}的id不能含首尾空格`)
      if (found.has(row.id)) problems.push(`${kind}重复id：${row.id}`)
      if (row.order !== undefined && !Number.isFinite(row.order)) problems.push(`${kind}的order需为有限数字`)
      found.add(row.id)
    }
    keys[kind] = found
  }
  for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!object(task)) continue
    if (task.visits !== undefined && !Array.isArray(task.visits)) { problems.push(`任务${task.id}的visits需为数组`); continue }
    for (const visit of task.visits || []) if (!keys.visits?.has(visit)) problems.push(`任务${task.id}引用未知访视${visit}`)
  }
  for (const followup of Array.isArray(raw.followups) ? raw.followups : []) {
    if (!object(followup)) continue
    if (!keys.visits?.has(followup.anchorVisit)) problems.push(`随访${followup.id}引用未知锚点${followup.anchorVisit}`)
    for (const key of ['offsetDays', 'earlyDays', 'lateDays']) {
      if (followup[key] !== undefined && (!Number.isInteger(followup[key]) || followup[key] < 0)) problems.push(`随访${followup.id}的${key}需为非负整数`)
    }
  }
  if (raw.plugins !== undefined && !object(raw.plugins)) problems.push('plugins需为对象')
  for (const [name, config] of Object.entries(object(raw.plugins) ? raw.plugins : {})) if (!object(config)) problems.push(`plugins.${name}需为对象`)
  return problems
}

/** Explicit studyPath or a stable path-based empty study. No automatic discovery or writes. */
export function loadStudyContext(config = {}, { cwd = process.cwd(), pluginKey = '' } = {}) {
  const studyPath = resolveStudyPath(cwd, config.studyPath)
  const root = path.resolve(config.projectRoot || cwd)
  let raw, text, base
  if (studyPath) {
    try { text = readFileSync(studyPath, 'utf8').replace(/^\uFEFF/, ''); raw = JSON.parse(text) }
    catch (error) { throw new StudyConfigError(`研究定义读取失败：${error.message}`) }
    const problems = validateStudyDefinition(raw)
    if (problems.length) throw new StudyConfigError(problems.join('；'))
    base = path.dirname(studyPath)
  } else {
    const dataRoot = path.resolve(config.labDir || config.stateDir || path.join(root, '_lab'))
    raw = { schemaVersion: 1, studyId: label(config.studyId) || `study-${digest(dataRoot).slice(0, 16)}`, name: label(config.studyName) || '默认研究', dataRoot, participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }
    text = JSON.stringify(raw); base = root
  }
  const dataRoot = path.resolve(base, raw.dataRoot || './data')
  const plugin = { ...(raw.plugins?.[pluginKey] || {}) }
  // Path values in the study document resolve relative to that document, never plugin cwd.
  for (const [key, value] of Object.entries(plugin)) if (typeof value === 'string' && /(?:Path|Dir)$/.test(key)) plugin[key] = resolveStudyPath(base, value)
  const participants = { ...(raw.participants || {}) }
  if (participants.path) participants.path = resolveStudyPath(base, participants.path)
  const pattern = raw.participantId?.pattern || ''
  const context = {
    id: raw.studyId, name: raw.name, path: studyPath, dataRoot, baseDir: base,
    revision: digest(text), configured: Boolean(studyPath), participantId: { ...(raw.participantId || {}) },
    participants, visits: [...(raw.visits || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    tasks: raw.tasks || [], followups: raw.followups || [], plugin,
    identity: { id: raw.studyId, name: raw.name, path: studyPath, dataRoot, revision: digest(text) },
    acceptsId(value) {
      if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001F\u007F]/u.test(value)) return false
      if (!pattern) return true
      const re = new RegExp(pattern, 'u'); const hit = re.exec(value)
      return Boolean(hit && hit.index === 0 && hit[0].length === value.length)
    }
  }
  return context
}
