// Dev smoke test: run the whole scan against the real project folder.
//   node tests/smoke.mjs
import { buildSnapshot } from '../scan.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 插件源码在 D:\dsh-plugins，数据项目仍在论文工作区；可用 STUDY_OPS_PROJECT 覆盖。
const ROOT = process.env.STUDY_OPS_PROJECT || 'C:/Users/16787/OneDrive/Desktop/yyh硕士论文'

const cfg = {
  projectRoot: ROOT,
  dataDir: path.join(ROOT, '正式实验数据', 'DDT'),
  idmDir: path.join(ROOT, '正式实验数据', 'IDM'),
  rosterPath: path.join(ROOT, 'Mortality 正式实验材料（主试用）', '00_主试操作清单', '被试分组名单_全局序号-编号-分组-音频.csv'),
  codesDir: path.join(ROOT, '03_延迟折扣任务与代码', 'Codes'),
  stateDir: path.join(ROOT, '_lab'),
  pythonPath: 'C:/Users/16787/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  qcScript: path.join(HERE, '..', 'qc.py'),
  targetTotal: 150,
  targetPerCell: 32
}

const snap = await buildSnapshot(cfg, { force: process.argv.includes('--force') })
console.log(JSON.stringify({
  qc: snap.qc,
  files: snap.files,
  enrollment: snap.enrollment,
  counts: snap.counts,
  demographics: snap.demographics,
  schedule: snap.schedule,
  anomalies: snap.anomalies.slice(0, 10),
  subjects: snap.subjects.filter(s => s.pendingData || s.planned).slice(0, 5)
}, null, 2))
