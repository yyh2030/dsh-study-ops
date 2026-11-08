import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { csvObjects, encodeCsv } from './csv.mjs'
import { readState, mutateState, fail } from './state-store.mjs'

const VERSION = 'ops-rules-1'
const hash = value => createHash('sha256').update(value).digest('hex')
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
export function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false; const d = new Date(value+'T00:00:00Z'); return Number.isFinite(+d) && d.toISOString().slice(0,10) === value }
const addDays = (date, days) => new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)
const daysBetween = (a,b) => Math.round((Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'))/86400000)
export function clock(value) { const s = String(value || '').trim(); const m = /^(\d{1,2}):([0-5]\d)$/.exec(s); return m && +m[1]<24 ? m[1].padStart(2,'0')+':'+m[2] : '' }
const minutes = s => +s.slice(0,2)*60 + +s.slice(3)
const stateFile = study => path.join(study.dataRoot, 'ops', study.id, 'state.json')

/** 性别归一：男/1/M → male，女/2/F → female，其余非空 → other，空 → unknown。 */
function normalizeSex(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return 'unknown'
  const lower = text.toLowerCase()
  if (['男', '男性', 'm', 'male', '1'].includes(lower)) return 'male'
  if (['女', '女性', 'f', 'female', '2'].includes(lower)) return 'female'
  return 'other'
}

/** 只读 demographics.json 的性别列，返回按参与者编号索引的性别。 */
async function readDemographics(study) {
  const file = path.join(study.dataRoot, 'demographics.json')
  let raw
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch (error) { return { present: false, total: 0, updatedAt: '', sexById: new Map() } }
  const rows = Array.isArray(raw.rows) ? raw.rows : Array.isArray(raw.dataset?.rows) ? raw.dataset.rows : []
  const columns = Array.isArray(raw.columns) ? raw.columns : Array.isArray(raw.dataset?.columns) ? raw.dataset.columns : []
  const sexKey = columns.find(column => column.key === 'sex')?.key || columns.find(column => String(column.label || '').includes('性别'))?.key
  if (!sexKey || !rows.length) return { present: false, total: 0, updatedAt: '', sexById: new Map() }
  const sexById = new Map()
  for (const row of rows) {
    const values = row && row.values && typeof row.values === 'object' ? row.values : row
    const id = String(row?.id ?? values?.id ?? '').trim()
    if (id) sexById.set(id, normalizeSex(values?.[sexKey]))
  }
  return { present: true, total: rows.length, updatedAt: String(raw.updatedAt || raw.exportedAt || ''), sexById }
}

async function source(file) {
  if (!file) return { state: 'unconfigured', rows: [], hash: '', error: '未配置来源' }
  try { const text = await readFile(file,'utf8'); const rows = csvObjects(text); return { state: rows.length ? 'ok' : 'empty', rows, hash: hash(text), path: file } }
  catch(error) { return { state: error.code === 'ENOENT' ? 'missing' : 'error', rows: [], hash: '', path:file, error:error.message } }
}
function taskApplies(task, participant, visit) {
  if (task.visits?.length && !task.visits.includes(visit.id)) return false
  const when = task.appliesTo || {}
  return Object.entries(when).every(([column, values]) => (Array.isArray(values) ? values : [values]).includes(participant[column]))
}
export async function buildSnapshot(study, options = {}) {
  const date = options.today || today()
  for (const task of study.tasks) {
    if (task.required !== undefined && typeof task.required !== 'boolean') throw fail('任务 required 应为布尔值', 'study_config')
    if (task.appliesTo !== undefined && (!task.appliesTo || typeof task.appliesTo !== 'object' || Array.isArray(task.appliesTo))) throw fail('任务 appliesTo 应为按列取值的对象', 'study_config')
  }
  const [participants, records, state, demo] = await Promise.all([source(study.participants.path), source(study.plugin.recordsPath), readState(stateFile(study)), readDemographics(study)])
  const issues = [], anomalies = [], byId = new Map(), rejected = new Set()
  const idColumn = study.participants.idColumn || 'participantId'
  const statusColumn = study.participants.statusColumn || 'status'
  for (const [i,row] of participants.rows.entries()) {
    const id = row[idColumn]
    if (!study.acceptsId(id)) { issues.push({ source:'participants', row:i+2, text:'参与者编号无效' }); continue }
    if (byId.has(id) || rejected.has(id)) { byId.delete(id); rejected.add(id); issues.push({ source:'participants', row:i+2, id, text:'参与者编号重复，未静默选择记录' }); continue }
    byId.set(id,row)
  }
  const expected = study.visits.flatMap(visit => study.tasks.filter(task => !task.visits?.length || task.visits.includes(visit.id)).map(task => ({ id:JSON.stringify([visit.id,task.id]),visitId:visit.id,taskId:task.id,label:(visit.label||visit.id)+' · '+(task.label||task.id), required:task.required!==false })))
  const validRecords = [], recordIds = new Set(), duplicateRecordIds = new Set()
  for (const [i,row] of records.rows.entries()) {
    const reasons=[]
    if (!study.acceptsId(row.participantId) || !byId.has(row.participantId)) reasons.push('编号无效或未在参与者表中')
    if (!study.visits.some(v=>v.id===row.visitId)) reasons.push('未知访视')
    const matchingTask=study.tasks.find(t=>t.id===row.taskId), matchingVisit=study.visits.find(v=>v.id===row.visitId)
    if (!matchingTask) reasons.push('未知任务')
    if (matchingTask && matchingVisit && byId.has(row.participantId) && !taskApplies(matchingTask,byId.get(row.participantId),matchingVisit)) reasons.push('任务不适用于该参与者或访视')
    if (!row.recordId?.trim()) reasons.push('缺少 recordId')
    else if (recordIds.has(row.recordId)) duplicateRecordIds.add(row.recordId)
    recordIds.add(row.recordId)
    if (!['complete','pending','failed','unknown'].includes(row.status)) reasons.push('未知记录状态')
    if (!row.date || !validDate(row.date)) reasons.push('记录日期为空或无效')
    if (reasons.length) { issues.push({source:'records',row:i+2,id:row.participantId,text:reasons.join('；')}); continue }
    validRecords.push({...row, observationHash:hash(JSON.stringify(row))})
  }
  for (const id of duplicateRecordIds) issues.push({source:'records',text:'recordId 重复，相关记录未采用：'+id})
  const usable = validRecords.filter(row=>!duplicateRecordIds.has(row.recordId))
  const subjects=[]
  for (const [id,participant] of byId) {
    const enrolled = (study.participants.enrolledValues || ['enrolled']).includes(participant[statusColumn])
    const groups=Object.fromEntries((study.participants.groupColumns || []).map(column=>[column, participant[column] || '']))
    const slots={}
    for (const column of expected) {
      const task=study.tasks.find(t=>t.id===column.taskId), visit=study.visits.find(v=>v.id===column.visitId)
      if (!taskApplies(task,participant,visit)) { slots[column.id]={state:'not_applicable',records:[]}; continue }
      const rows=usable.filter(row=>row.participantId===id && row.visitId===column.visitId && row.taskId===column.taskId)
      const plannedDates=(state.schedules||[]).filter(s=>s.id===id&&s.visitId===visit.id&&s.attendance!=='noshow').map(s=>s.date)
      const expectedDate=visit.dateColumn?participant[visit.dateColumn]:visit.date||plannedDates.sort()[0]||''
      let stateName=rows.length===0?(validDate(expectedDate)&&expectedDate>date?'not_due':'missing'):rows.length>1?'conflict':({complete:'ok',pending:'pending',failed:'bad',unknown:'unknown'}[rows[0].status])
      slots[column.id]={state:stateName, records:rows.map(r=>({recordId:r.recordId,date:r.date,status:r.status,observationHash:r.observationHash})), optional:!column.required}
      if (enrolled && ((column.required && stateName==='missing') || ['conflict','bad','unknown'].includes(stateName))) {
        const text=column.label+'：'+({missing:'缺少记录',conflict:'多份观测待选择',bad:'失败',unknown:'质量未知'}[stateName])
        const observation=hash(JSON.stringify([rows, column, task]))
        const key=hash(JSON.stringify([VERSION,id,column.id,stateName,observation]))
        anomalies.push({key,id,code:stateName,level:['bad','conflict'].includes(stateName)?'bad':'warn',text,observationHash:observation,ruleVersion:VERSION})
      }
    }
    const followups=study.followups.map(rule=>{
      const label=rule.label||study.visits.find(visit=>visit.id===(rule.visitId||rule.id))?.label||'随访'
      const anchorColumns=expected.filter(c=>c.visitId===rule.anchorVisit && c.required && slots[c.id].state!=='not_applicable')
      const complete=anchorColumns.length>0 && anchorColumns.every(c=>slots[c.id].state==='ok' && validDate(slots[c.id].records[0].date))
      const anchor=complete?anchorColumns.map(c=>slots[c.id].records[0].date).sort().at(-1):''
      if(!anchor || !enrolled) return {id:rule.id,label,state:'unknown',due:''}
      const due=addDays(anchor,rule.offsetDays||0), delta=daysBetween(date,due)
      const done=state.followups?.[JSON.stringify([id,rule.id])]?.done
      return {id:rule.id,label,due,days:delta,state:done?'done':delta<-(rule.earlyDays||0)?'scheduled':delta>(rule.lateDays||0)?'overdue':'due'}
    })
    subjects.push({id,groups,enrolled,planned:!enrolled,slots,followups})
  }
  const active=[],dismissed=[]
  for(const a of anomalies) { const record=state.dismissed?.[a.key]; if(record) dismissed.push({...a,dismissedAt:record.at,note:record.note}); else active.push(a) }
  subjects.forEach(s=>{s.hasIssue=active.some(a=>a.id===s.id)})
  const schedule=(state.schedules||[]).map(item=>{
    const delta=daysBetween(date,item.date),phase=delta>0?'past':delta===0?'today':'future'
    const matched=usable.some(r=>r.participantId===item.id && r.visitId===item.visitId && r.status==='complete' && r.date===item.date)
    return {...item,phase,status:item.attendance || (phase!=='future'&&matched?'data':phase==='past'?'missed':'planned')}
  })
  const latestState=await readState(stateFile(study))
  if(latestState.revision!==state.revision)throw fail('状态正在更新，请刷新后重试','conflict')
  const sex={male:0,female:0,unknown:0,other:0}, sexByGroup={}
  if(demo.present){
    for(const subject of subjects){
      if(!subject.enrolled) continue
      const key=Object.values(subject.groups).join(' · ')||'未分组'
      const value=demo.sexById.get(String(subject.id))||'unknown'
      sex[value]=(sex[value]||0)+1
      sexByGroup[key] ||= {male:0,female:0,unknown:0,other:0}
      sexByGroup[key][value]=(sexByGroup[key][value]||0)+1
    }
  }
  return {study:study.identity,generatedAt:new Date().toISOString(),today:date,stateRevision:state.revision,ruleVersion:VERSION,inputRevision:hash(JSON.stringify([study.revision,participants.hash,records.hash])),columns:expected,visits:study.visits,subjects,schedule,anomalies:active,dismissed,fileIssues:issues,sources:{participants:{...participants,rows:undefined},records:{...records,rows:undefined}},demographics:{present:demo.present,total:demo.total,updatedAt:demo.updatedAt,sex,byGroup:sexByGroup},enrollment:{n:subjects.filter(s=>s.enrolled).length,total:subjects.length,groups:subjects.filter(s=>s.enrolled).reduce((out,s)=>{const key=Object.values(s.groups).join(' · ')||'未分组';out[key]=(out[key]||0)+1;return out},{})},counts:{bad:active.filter(a=>a.level==='bad').length,warn:active.filter(a=>a.level!=='bad').length,followupDue:subjects.flatMap(s=>s.followups).filter(f=>['due','overdue'].includes(f.state)).length},empty:!study.configured&&!study.participants.path&&!study.plugin.recordsPath}
}

export async function mutate(study, action, payload={}) {
  const id=String(payload.id??'')
  if((action==='followup'||(action==='schedule'&&payload.op!=='remove'))&&!study.acceptsId(id)) throw fail('参与者编号无效')
  return mutateState(stateFile(study),payload.stateRevision,async state=>{
    if(action==='schedule') {
      state.schedules ||= []
      if(payload.op==='remove') {state.schedules=state.schedules.filter(s=>s.key!==payload.key); return {removed:true}}
      const snapshot=await buildSnapshot(study)
      if(!snapshot.subjects.some(s=>s.id===id)) throw fail('参与者不在当前参与者表中')
      if(!validDate(payload.date)) throw fail('日期应为有效的 YYYY-MM-DD 日历日期')
      if(!study.visits.some(v=>v.id===payload.visitId)) throw fail('请选择有效访视')
      const start=clock(payload.start),end=clock(payload.end)
      if((payload.start&&!start)||(payload.end&&!end)) throw fail('时间应为 00:00–23:59')
      if(end&&(!start||minutes(end)<=minutes(start))) throw fail('结束时间应晚于开始时间')
      const resource=String(payload.resource||'')
      if(start&&end&&state.schedules.some(s=>s.date===payload.date&&s.start&&s.end&&(s.id===id||(resource&&s.resource===resource))&&minutes(start)<minutes(s.end)&&minutes(end)>minutes(s.start))) throw fail('该参与者或资源的时间段与已有预约冲突','conflict')
      const item={key:randomUUID(),id,visitId:payload.visitId,date:payload.date,start,end,resource,note:String(payload.note||''),createdAt:new Date().toISOString()}; state.schedules.push(item);return item
    }
    if(action==='attendance') {const item=(state.schedules||[]).find(s=>s.key===payload.key);if(!item)throw fail('预约不存在');if(!['','arrived','noshow'].includes(payload.status))throw fail('未知到场状态');item.attendance=payload.status;return item}
    if(action==='followup') {const snap=await buildSnapshot(study);if(!snap.subjects.some(s=>s.id===id))throw fail('参与者不在当前研究中');if(!study.followups.some(f=>f.id===payload.followupId))throw fail('未知随访');state.followups ||= {};state.followups[JSON.stringify([id,payload.followupId])]={done:Boolean(payload.done),at:new Date().toISOString()};return {id}}
    if(action==='dismiss') {const snap=await buildSnapshot(study);if(!snap.anomalies.some(a=>a.key===payload.key))throw fail('异常已变化，请刷新','conflict');state.dismissed ||= {};state.dismissed[payload.key]={at:new Date().toISOString(),note:String(payload.note||'')};return {key:payload.key}}
    if(action==='restore') {state.dismissed ||= {};if(payload.key)delete state.dismissed[payload.key];else state.dismissed={};return {restored:true}}
    throw fail('未知写入操作')
  })
}
export function summaryText(snap,focus='all') {
  const lines=[`状态版本 stateRevision=${snap.stateRevision}（写入时使用）。`]
  if(['all','summary'].includes(focus)) {lines.push(`${snap.study.name}：已入组 ${snap.enrollment.n} / 参与者 ${snap.enrollment.total}。`);for(const [group,n]of Object.entries(snap.enrollment.groups))lines.push(`${group}：${n}`)}
  if(['all','anomalies'].includes(focus)) {lines.push(`异常：高 ${snap.counts.bad}，中 ${snap.counts.warn}；已忽略 ${snap.dismissed.length}。`);for(const a of snap.anomalies)lines.push(`${a.id}：${a.text}`);for(const issue of snap.fileIssues)lines.push(`来源问题：${issue.text}`);for(const[name,s]of Object.entries(snap.sources))if(!['ok','empty'].includes(s.state))lines.push(`${name}：${s.state} ${s.error||''}`)}
  if(['all','followup'].includes(focus)) {lines.push(`随访待办 ${snap.counts.followupDue} 项。`);for(const s of snap.subjects)for(const f of s.followups)if(['due','overdue'].includes(f.state))lines.push(`${s.id} ${f.label}：${f.due}`)}
  return lines.join('\n')
}
export async function exportReport(study,snap) {
  const dir=path.join(study.dataRoot,'ops','export');await mkdir(dir,{recursive:true});const base='study-ops-'+today()+'-'+randomUUID().slice(0,8)
  const anomalies=[...snap.anomalies,...snap.dismissed]
  const files=[{name:base+'.json',path:path.join(dir,base+'.json')},{name:base+'-anomalies.csv',path:path.join(dir,base+'-anomalies.csv')}]
  await writeFile(files[0].path,JSON.stringify(snap,null,2),'utf8')
  await writeFile(files[1].path,encodeCsv([['participantId','text','status','dismissedAt','note','ruleVersion','observationHash'],...anomalies.map(a=>[a.id,a.text,a.dismissedAt?'dismissed':'active',a.dismissedAt,a.note,a.ruleVersion,a.observationHash])]),'utf8')
  return {dir,files}
}
