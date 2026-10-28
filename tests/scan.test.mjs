// Unit tests for the scan layer: parser, dates, session labels, snapshot.
//   node tests/scan.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { addDays, addSchedule, compose, dayDiff, dismissAnomaly, normalizeSex, normalizeSession, parseCsv, readDemographics, readRoster, readSchedule, removeScheduleMatch, restoreAnomaly, setAttendance, todayString } from '../scan.js'

test('parseCsv handles BOM, quotes, commas and CRLF', () => {
  const rows = parseCsv('\uFEFFa,b,c\r\n1,"x, y",3\r\n"he said ""hi""",,\r\n')
  assert.deepEqual(rows[0], ['a', 'b', 'c'])
  assert.deepEqual(rows[1], ['1', 'x, y', '3'])
  assert.equal(rows[2][0], 'he said "hi"')
})

test('normalizeSession maps 001/1/003/3 and rejects the rest', () => {
  assert.equal(normalizeSession('001'), 'T0')
  assert.equal(normalizeSession('1'), 'T0')
  assert.equal(normalizeSession('002'), 'T1')
  assert.equal(normalizeSession('3'), 'T2')
  assert.equal(normalizeSession(''), '')
  assert.equal(normalizeSession('004'), '')
})

test('addDays and dayDiff cross month and year boundaries', () => {
  assert.equal(addDays('2026-12-28', 7), '2027-01-04')
  assert.equal(dayDiff('2027-01-04', '2026-12-28'), 7)
  assert.equal(dayDiff('2026-03-01', '2026-02-28'), 1)
  assert.ok(Number.isNaN(dayDiff('', '2026-01-01')))
})

test('todayString is a local YYYY-MM-DD', () => {
  assert.match(todayString(new Date(2026, 9, 27)), /^2026-10-27$/)
})

test('readRoster skips the legend row and keeps five-digit ids', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'study-ops-'))
  try {
    const file = path.join(dir, 'roster.csv')
    await writeFile(file, '11 (MS*EFT); 12 (MS*ERT)\n全局序号,分组码,被试编号,音频文件,姓名,联系方式\n1,11,11002,EFT/3.mp3,张三,138\n2,21,21003,,,\n', 'utf8')
    const roster = await readRoster(file)
    assert.equal(roster.ok, true)
    assert.equal(roster.byId.size, 2)
    assert.equal(roster.byId.get('11002').code, '11')
    assert.equal(roster.byId.get('11002').name, '张三')
    assert.equal(roster.byId.get('21003').name, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function emptyIdm() {
  return {
    phase1: { byId: new Map(), cleanById: new Set() },
    phase2: { byId: new Map(), cleanById: new Set() },
    phase3: { byId: new Map(), cleanById: new Set() }
  }
}

function idmWith(id, phase, clean = true) {
  const idm = emptyIdm()
  idm[phase].byId.set(id, [{ id, name: id + '_' + phase + '.csv', path: '/x' }])
  if (clean) idm[phase].cleanById.add(id)
  return idm
}

test('compose: complete subject, follow-up due, cells counted', async () => {
  const roster = {
    ok: true,
    byId: new Map([
      ['11002', { id: '11002', code: '11', audio: 'EFT/3.mp3', name: '张三', phone: '138' }]
    ])
  }
  const qc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0, rtMedian: 1.1, llRate: 0.7, participant: '11002' }
  const ddt = ['T0', 'T1', 'T2'].map(label => ({ id: '11002', session: label, date: '2026-10-20', name: 'f.csv', qc }))
  const idm = { ...emptyIdm() }
  for (const phase of ['phase1', 'phase2', 'phase3']) {
    idm[phase].byId.set('11002', [{ id: '11002', name: 'idm.csv', path: '/y' }])
    idm[phase].cleanById.add('11002')
  }
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt, idm }, { followups: {} }, '2026-10-27')
  assert.equal(snap.enrollment.n, 1)
  assert.equal(snap.enrollment.cells['11'].n, 1)
  assert.equal(snap.enrollment.cells['12'].n, 0)
  const subject = snap.subjects.find(s => s.id === '11002')
  assert.equal(subject.sessions.T0.state, 'ok')
  assert.equal(subject.sessions.T0.trials, 60)
  assert.equal(subject.followup.due, '2026-10-27')
  assert.equal(subject.followup.state, 'due')
  assert.equal(snap.anomalies.length, 0)
})

test('compose: missing T2 and a short file are both high-level', async () => {
  const roster = { ok: true, byId: new Map() }
  const short = { ok: true, trials: 58, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0 }
  const ddt = [
    { id: '12004', session: 'T0', date: '2026-10-21', name: 'a.csv', qc: short },
    { id: '12004', session: 'T1', date: '2026-10-21', name: 'b.csv', qc: short }
  ]
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt, idm: emptyIdm() }, { followups: {} }, '2026-10-27')
  const subject = snap.subjects.find(s => s.id === '12004')
  assert.equal(subject.sessions.T0.state, 'bad')
  assert.equal(subject.sessions.T2.state, 'missing')
  const texts = snap.anomalies.map(a => a.text).join('\n')
  assert.match(texts, /缺 T2/)
  assert.match(texts, /试次 58\/60/)
  for (const a of snap.anomalies) {
    assert.ok(a.hint && a.hint.length > 8, '每条异常都应带一句人话解释：' + a.text)
  }
})

test('compose: follow-up done wins over the date window', async () => {
  const roster = { ok: true, byId: new Map() }
  const qc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0 }
  const ddt = [
    { id: '21001', session: 'T0', date: '2026-10-01', name: 'a.csv', qc },
    { id: '21001', session: 'T1', date: '2026-10-01', name: 'b.csv', qc },
    { id: '21001', session: 'T2', date: '2026-10-01', name: 'c.csv', qc }
  ]
  const snap = await compose(
    { targetTotal: 150, targetPerCell: 32 },
    { roster, ddt, idm: emptyIdm() },
    { followups: { 21001: { done: true, at: '2026-10-09' } } },
    '2026-10-27'
  )
  assert.equal(snap.subjects[0].followup.state, 'done')
})

test('compose: a roster name without data is pending, not an error', async () => {
  const roster = {
    ok: true,
    byId: new Map([['11003', { id: '11003', code: '11', audio: '', name: '李四', phone: '' }]])
  }
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt: [], idm: emptyIdm() }, { followups: {} }, '2026-10-27')
  const subject = snap.subjects.find(s => s.id === '11003')
  assert.equal(subject.registered, true)
  assert.equal(subject.pendingData, true)
  // 名单登记即算入组：他当天收完就写名单，数据可以晚几天导入。
  assert.equal(snap.enrollment.n, 1)
  assert.equal(snap.counts.pendingData, 1)
  assert.equal(snap.anomalies.length, 0)
})

test('compose: schedule supplies T0 for a pending subject and reports item status', async () => {
  const roster = {
    ok: true,
    byId: new Map([['11003', { id: '11003', code: '11', audio: '', name: '李四', phone: '' }]])
  }
  const schedule = [
    { key: 'k1', id: '11003', date: '2026-10-26', start: '10:00', end: '11:30', note: '' },
    { key: 'k2', id: '22014', date: '2026-10-27', start: '14:00', end: '', note: '' }
  ]
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt: [], idm: emptyIdm(), schedule }, { followups: {} }, '2026-10-27')
  const subject = snap.subjects.find(s => s.id === '11003')
  assert.equal(subject.t0, '2026-10-26')
  assert.equal(subject.t0source, 'schedule')
  assert.equal(snap.schedule[0].phase, 'past')
  assert.equal(snap.schedule[0].status, 'tested')
  assert.equal(snap.schedule[1].phase, 'today')
  assert.equal(snap.schedule[1].status, 'planned')
  assert.equal(snap.counts.planToday, 1)
})

test('compose: demographics completion is counted per enrolled subject', async () => {
  const roster = { ok: true, byId: new Map() }
  const qc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0 }
  const ddt = ['T0', 'T1', 'T2'].map(label => ({ id: '11002', session: label, date: '2026-10-20', name: 'f.csv', qc }))
  const demo = {
    present: true,
    total: 12,
    updatedAt: '2026-10-27T00:00:00Z',
    byId: new Map([['11002', { filled: 8, total: 12, sex: 'female' }]])
  }
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt, idm: emptyIdm(), demo }, { followups: {} }, '2026-10-27')
  const subject = snap.subjects.find(s => s.id === '11002')
  assert.equal(subject.demo.present, true)
  assert.equal(subject.demo.filled, 8)
  assert.equal(subject.demo.sex, 'female')
  assert.equal(snap.demographics.done, 0)
  assert.equal(snap.demographics.partial, 1)
  assert.equal(snap.demographics.missing, 0)
  assert.equal(snap.demographics.sex.female, 1)
  assert.equal(snap.demographics.sex.male, 0)
  assert.equal(snap.enrollment.cells['11'].sex.female, 1)
})

test('normalizeSex maps common spellings', () => {
  assert.equal(normalizeSex('男'), 'male')
  assert.equal(normalizeSex('1'), 'male')
  assert.equal(normalizeSex('M'), 'male')
  assert.equal(normalizeSex('女'), 'female')
  assert.equal(normalizeSex('2'), 'female')
  assert.equal(normalizeSex('female'), 'female')
  assert.equal(normalizeSex(''), '')
  assert.equal(normalizeSex('其他'), 'other')
})

test('compose: sex counts split by cell and by unknown', async () => {
  const roster = { ok: true, byId: new Map() }
  const qc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0 }
  const ddt = [
    { id: '11002', session: 'T0', date: '2026-10-20', name: 'a.csv', qc },
    { id: '11002', session: 'T1', date: '2026-10-20', name: 'b.csv', qc },
    { id: '11002', session: 'T2', date: '2026-10-20', name: 'c.csv', qc },
    { id: '21001', session: 'T0', date: '2026-10-20', name: 'd.csv', qc },
    { id: '21001', session: 'T1', date: '2026-10-20', name: 'e.csv', qc },
    { id: '21001', session: 'T2', date: '2026-10-20', name: 'f.csv', qc }
  ]
  const demo = {
    present: true,
    total: 12,
    byId: new Map([
      ['11002', { filled: 12, total: 12, sex: 'male' }],
      ['21001', { filled: 12, total: 12, sex: 'female' }]
    ])
  }
  const snap = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt, idm: emptyIdm(), demo }, { followups: {} }, '2026-10-27')
  assert.equal(snap.demographics.sex.male, 1)
  assert.equal(snap.demographics.sex.female, 1)
  assert.equal(snap.enrollment.cells['11'].sex.male, 1)
  assert.equal(snap.enrollment.cells['21'].sex.female, 1)
  assert.equal(snap.demographics.sex.unknown, 0)
})

test('schedule round-trip: add, read, remove by id and date', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'study-ops-'))
  try {
    const cfg = { stateDir: dir }
    await addSchedule(cfg, { id: '22017', date: '2026-10-28', start: '11:00', end: '12:30' })
    await addSchedule(cfg, { id: '11018', date: '2026-10-28', start: '17:00', end: '18:30' })
    await addSchedule(cfg, { id: '11016', date: '2026-10-28', start: '9:00', end: '10:30', note: '上午' })
    const items = await readSchedule(cfg)
    assert.equal(items.length, 3)
    // 时间按从早到晚排：9:00 补成 09:00，并排在最前
    assert.deepEqual(items.map(item => item.id), ['11016', '22017', '11018'])
    assert.equal(items[0].start, '09:00')
    await removeScheduleMatch(cfg, { id: '22017', date: '2026-10-28' })
    const left = await readSchedule(cfg)
    assert.equal(left.length, 2)
    assert.deepEqual(left.map(item => item.id), ['11016', '11018'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readDemographics counts filled columns per subject', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'study-ops-'))
  try {
    await writeFile(path.join(dir, 'demographics.json'), JSON.stringify({
      name: '本实验基本信息表',
      columns: [{ key: 'sex' }, { key: 'age' }, { key: 'edu' }],
      rows: [{ id: '11002', sex: '男', age: '23', edu: '' }]
    }), 'utf8')
    const demo = await readDemographics({ stateDir: dir })
    assert.equal(demo.present, true)
    assert.equal(demo.total, 3)
    assert.equal(demo.byId.get('11002').filled, 2)
    assert.equal(demo.byId.get('11002').total, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compose: a dismissed anomaly leaves the list and is reported separately', async () => {
  const roster = { ok: true, byId: new Map() }
  const okQc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0, slowShare: 0 }
  const fastQc = { ok: true, trials: 60, badCells: 0, timeoutShare: 0, fastShare: 0.12, slowShare: 0 }
  const ddt = [
    { id: '12009', session: 'T0', date: '2026-10-22', name: 'a.csv', qc: okQc },
    { id: '12009', session: 'T1', date: '2026-10-22', name: 'b.csv', qc: okQc },
    { id: '12009', session: 'T2', date: '2026-10-22', name: 'c.csv', qc: fastQc }
  ]
  const idm = emptyIdm()
  for (const phase of ['phase1', 'phase2', 'phase3']) {
    idm[phase].byId.set('12009', [{ id: '12009', name: 'x.csv', path: '/x' }])
    idm[phase].cleanById.add('12009')
  }
  const before = await compose({ targetTotal: 150, targetPerCell: 32 }, { roster, ddt, idm }, { followups: {} }, '2026-10-27')
  const target = before.anomalies.find(a => a.code === 'qc' && a.session === 'T2')
  assert.ok(target, 'T2 应该有一条 QC 警告')
  assert.match(target.hint, /0\.2 秒/)
  const after = await compose(
    { targetTotal: 150, targetPerCell: 32 },
    { roster, ddt, idm },
    { followups: {}, dismissed: { [target.key]: { at: '2026-10-27', note: '已核对原始数据' } } },
    '2026-10-27'
  )
  assert.equal(after.anomalies.filter(a => a.key === target.key).length, 0)
  assert.equal(after.dismissed.length, 1)
  assert.equal(after.dismissed[0].note, '已核对原始数据')
  assert.equal(after.counts.dismissed, 1)
})

test('dismiss and restore persist in state.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'study-ops-'))
  try {
    const cfg = { stateDir: dir }
    await dismissAnomaly(cfg, '12009|qc|T2', '已核对 RT')
    const first = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    assert.equal(first.dismissed['12009|qc|T2'].note, '已核对 RT')
    await restoreAnomaly(cfg, '12009|qc|T2')
    const second = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    assert.equal(Object.keys(second.dismissed).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compose: manual attendance overrides the auto status', async () => {
  const roster = { ok: true, byId: new Map() }
  const schedule = [{ key: 'k1', id: '11016', date: '2026-10-28', start: '09:00', end: '10:30', note: '' }]
  const cfg = { targetTotal: 150, targetPerCell: 32 }

  const auto = await compose(cfg, { roster, ddt: [], idm: emptyIdm(), schedule }, { followups: {} }, '2026-10-28')
  assert.equal(auto.schedule[0].status, 'planned')
  assert.equal(auto.schedule[0].auto, 'planned')
  assert.equal(auto.schedule[0].manual, false)

  const arrived = await compose(cfg, { roster, ddt: [], idm: emptyIdm(), schedule }, {
    followups: {}, attendance: { k1: { status: 'arrived', at: '2026-10-28' } }
  }, '2026-10-28')
  assert.equal(arrived.schedule[0].status, 'arrived')
  assert.equal(arrived.schedule[0].manual, true)

  const noshow = await compose(cfg, { roster, ddt: [], idm: emptyIdm(), schedule }, {
    followups: {}, attendance: { k1: { status: 'noshow', at: '2026-10-28' } }
  }, '2026-10-28')
  assert.equal(noshow.schedule[0].status, 'noshow')
})

test('setAttendance writes and clears the override', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'study-ops-'))
  try {
    const cfg = { stateDir: dir }
    await addSchedule(cfg, { id: '11016', date: '2026-10-28', start: '09:00', end: '10:30' })
    const items = await readSchedule(cfg)
    await setAttendance(cfg, items[0].key, 'arrived')
    const first = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    assert.equal(first.attendance[items[0].key].status, 'arrived')
    await setAttendance(cfg, items[0].key, '')
    const second = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    assert.equal(second.attendance && Object.keys(second.attendance).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
