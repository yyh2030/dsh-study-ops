/**
 * study-ops — browser half.
 *
 * One panel: enrollment progress, a per-subject matrix of DDT sessions and IDM
 * phases, the QC anomalies, and the follow-up queue. Everything comes from the
 * Host route; the page never reads the data folders itself.
 */
window.__ModuleLoader__.load({
  id: '@local/study-ops',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const API = '/api/study-ops'

    async function call(action, payload, query) {
      let url = API + '?action=' + encodeURIComponent(action)
      if (query) {
        const qs = new URLSearchParams(query).toString()
        if (qs) url += '&' + qs
      }
      const init = { headers: { 'x-study-ops': '1' } }
      if (payload !== undefined) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify({ action, payload })
      }
      const res = await fetch(url, init)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        throw new Error((json.error && json.error.message) || 'HTTP ' + res.status)
      }
      return json.data
    }

    /* ================================================================ *
     * styles
     * ================================================================ */

    const CSS = `
.so-root{--so-bg:var(--dsw-alias-bg-base,#fff);--so-panel:var(--dsw-alias-bg-layer-1,#f7f7f8);--so-raised:var(--dsw-alias-bg-layer-2,#f1f2f4);--so-line:var(--dsw-alias-border-l1,rgba(0,0,0,.09));--so-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.16));--so-text:var(--dsw-alias-label-primary,#16181d);--so-text2:var(--dsw-alias-label-secondary,#5b6068);--so-brand:var(--dsw-alias-brand-primary,#3f5efb);--so-ok:var(--dsw-alias-state-success-primary,#148a62);--so-warn:var(--dsw-alias-state-warn-primary,#b7791f);--so-bad:var(--dsw-alias-state-error-primary,#c0392b);display:flex;flex-direction:column;height:100%;min-height:0;background:var(--so-bg);color:var(--so-text);font-size:13px;line-height:1.55;overflow:hidden}
.so-root *{box-sizing:border-box}
.so-top{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid var(--so-line);flex:none}
.so-brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.so-brand strong{font-size:14px;font-weight:650;white-space:nowrap}
.so-brand span{font-size:11.5px;color:var(--so-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46ch}
.so-top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.so-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid transparent;font-size:12.5px;cursor:pointer;white-space:nowrap;background:transparent;color:var(--so-text)}
.so-btn:disabled{opacity:.55;cursor:default}
.so-btn-primary{background:var(--so-brand);color:var(--dsw-alias-bg-base,#fff)}
.so-btn-ghost{color:var(--so-text2)}
.so-btn-ghost:hover:not(:disabled){background:var(--so-raised);color:var(--so-text)}
.so-btn-outline{background:var(--so-bg);border-color:var(--so-line2)}
.so-btn-outline:hover:not(:disabled){background:var(--so-raised)}
.so-btn-sm{height:22px;padding:0 8px;font-size:11.5px;border-radius:6px}
.so-scroll{flex:1;min-height:0;overflow:auto;padding:16px 16px 40px}
.so-progress{border:1px solid var(--so-line);border-radius:14px;background:var(--so-panel);padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.so-progress-main{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap}
.so-big{font-size:30px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.so-big small{font-size:13px;font-weight:500;color:var(--so-text2);margin-left:4px;letter-spacing:0}
.so-meta{display:flex;flex-wrap:wrap;gap:14px;color:var(--so-text2);font-size:12px}
.so-meta b{color:var(--so-text);font-weight:600;font-variant-numeric:tabular-nums}
.so-cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.so-cell{border:1px solid var(--so-line);border-radius:10px;background:var(--so-bg);padding:9px 11px;display:flex;flex-direction:column;gap:6px;min-width:0}
.so-cell-head{display:flex;align-items:baseline;gap:7px}
.so-cell-code{font-weight:650;font-size:12.5px}
.so-cell-name{font-size:11px;color:var(--so-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.so-cell-n{margin-left:auto;font-size:11.5px;color:var(--so-text2);font-variant-numeric:tabular-nums}
.so-bar{height:5px;border-radius:999px;background:var(--so-raised);overflow:hidden}
.so-bar i{display:block;height:100%;border-radius:999px;background:var(--so-brand)}
.so-toolbar{display:flex;align-items:center;gap:8px;margin:16px 0 8px;flex-wrap:wrap}
.so-chip{height:26px;padding:0 11px;border-radius:999px;border:1px solid var(--so-line);background:var(--so-bg);color:var(--so-text2);font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.so-chip.is-active{color:var(--so-text);border-color:var(--so-line2);background:var(--so-raised);font-weight:600}
.so-chip b{font-variant-numeric:tabular-nums;font-weight:600}
.so-table-wrap{border:1px solid var(--so-line);border-radius:12px;overflow:auto;background:var(--so-bg);max-height:none}
.so-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:720px}
.so-table th{position:sticky;top:0;z-index:1;background:var(--so-bg);text-align:left;padding:9px 10px;border-bottom:1px solid var(--so-line2);font-weight:600;white-space:nowrap;font-size:11.5px;color:var(--so-text2)}
.so-table td{padding:7px 10px;border-bottom:1px solid var(--so-line);white-space:nowrap;vertical-align:middle}
.so-table tbody tr{cursor:pointer}
.so-table tbody tr:hover td{background:color-mix(in oklab,var(--so-raised) 60%,transparent)}
.so-table tbody tr.is-open td{background:color-mix(in oklab,var(--so-brand) 7%,transparent)}
.so-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;letter-spacing:.2px}
.so-state{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;font-size:12px;font-weight:700}
.so-state-ok{color:var(--so-ok);background:color-mix(in oklab,var(--so-ok) 10%,transparent)}
.so-state-warn{color:var(--so-warn);background:color-mix(in oklab,var(--so-warn) 12%,transparent)}
.so-state-bad{color:var(--so-bad);background:color-mix(in oklab,var(--so-bad) 10%,transparent)}
.so-state-missing,.so-state-unknown{color:var(--so-text2);background:var(--so-raised)}
.so-follow{font-size:11.5px;color:var(--so-text2)}
.so-follow.is-due{color:var(--so-warn);font-weight:600}
.so-follow.is-overdue{color:var(--so-bad);font-weight:600}
.so-scheduled{font-size:10.5px;color:var(--so-brand);border:1px solid color-mix(in oklab,var(--so-brand) 36%,var(--so-line));border-radius:999px;padding:1px 7px;margin-left:6px}
.so-detail{border:1px solid var(--so-line2);border-radius:12px;background:var(--so-panel);padding:14px 16px;margin-top:12px;display:flex;flex-direction:column;gap:12px}
.so-detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.so-detail-head strong{font-size:14px}
.so-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.so-kv-item{border:1px solid var(--so-line);border-radius:9px;background:var(--so-bg);padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.so-kv-item span{font-size:10.5px;color:var(--so-text2)}
.so-kv-item b{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
.so-flag{font-size:11.5px;color:var(--so-warn)}
.so-note{font-size:11.5px;color:var(--so-text2)}
.so-alert{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:9px;margin-bottom:12px;font-size:12px;border:1px solid transparent}
.so-alert-bad{color:var(--so-bad);background:color-mix(in oklab,var(--so-bad) 8%,transparent);border-color:color-mix(in oklab,var(--so-bad) 22%,transparent)}
.so-alert-warn{color:var(--so-warn);background:color-mix(in oklab,var(--so-warn) 9%,transparent);border-color:color-mix(in oklab,var(--so-warn) 24%,transparent)}
.so-alert-ok{color:var(--so-ok);background:color-mix(in oklab,var(--so-ok) 8%,transparent);border-color:color-mix(in oklab,var(--so-ok) 22%,transparent)}
.so-anomalies{border:1px solid var(--so-line);border-radius:12px;background:var(--so-panel);padding:10px 14px;margin-top:12px}
.so-anomalies h4{margin:2px 0 6px;font-size:12px;font-weight:600;color:var(--so-text2)}
.so-anom{display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:12px}
.so-anom button{border:0;background:transparent;color:var(--so-text);cursor:pointer;padding:0;text-align:left;font-size:12px}
.so-anom button:hover{text-decoration:underline}
.so-anom-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.so-anom-hint{font-size:11px;color:var(--so-text2);line-height:1.55}
.so-lv{flex:none;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid currentColor}
.so-lv-bad{color:var(--so-bad)}
.so-lv-warn{color:var(--so-warn)}
.so-empty{border:1px dashed var(--so-line2);border-radius:14px;padding:34px 20px;text-align:center;color:var(--so-text2);display:flex;flex-direction:column;align-items:center;gap:8px}
.so-empty strong{color:var(--so-text);font-size:14px}
.so-footer{font-size:11px;color:var(--so-text2);margin-top:14px;display:flex;gap:12px;flex-wrap:wrap}
.so-contact{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--so-text2)}
.so-contact b{color:var(--so-text);font-weight:500}
.so-pending{font-size:10.5px;color:var(--so-warn);border:1px solid color-mix(in oklab,var(--so-warn) 40%,var(--so-line));border-radius:999px;padding:1px 7px;margin-left:6px;white-space:nowrap}
.so-plan{border:1px solid var(--so-line);border-radius:12px;background:var(--so-panel);padding:12px 14px;margin-top:14px;display:flex;flex-direction:column;gap:10px}
.so-plan-head{display:flex;align-items:center;gap:10px}
.so-plan-head h4{margin:0;font-size:12.5px;font-weight:650}
.so-plan-head span{font-size:11.5px;color:var(--so-text2)}
.so-plan-list{display:flex;flex-direction:column;gap:4px}
.so-plan-row{display:grid;grid-template-columns:150px 62px minmax(0,1fr) auto;gap:12px;align-items:center;padding:5px 8px;border:1px solid var(--so-line);border-radius:8px;background:var(--so-bg);font-size:12px}
.so-plan-time{font-variant-numeric:tabular-nums;color:var(--so-text2);font-size:11.5px;white-space:nowrap}
.so-plan-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.so-plan-status{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--so-line);color:var(--so-text2)}
.so-plan-status.is-data{color:var(--so-ok);border-color:color-mix(in oklab,var(--so-ok) 40%,var(--so-line))}
.so-plan-status.is-tested{color:var(--so-brand);border-color:color-mix(in oklab,var(--so-brand) 40%,var(--so-line))}
.so-plan-status.is-missed{color:var(--so-bad);border-color:color-mix(in oklab,var(--so-bad) 40%,var(--so-line))}
.so-plan-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-top:1px dashed var(--so-line);padding-top:10px}
.so-plan-form input{height:28px;padding:0 8px;border:1px solid var(--so-line);border-radius:7px;background:var(--so-bg);color:var(--so-text);font-size:12px;outline:none;min-width:0}
.so-plan-form input:focus{border-color:var(--so-brand)}
.so-plan-form .so-in-id{width:82px}
.so-plan-form .so-in-date{width:128px}
.so-plan-form .so-in-time{width:74px}
.so-plan-form .so-in-note{flex:1;min-width:120px}
.so-demo-cell{font-size:11.5px;color:var(--so-text2);font-variant-numeric:tabular-nums}
.so-demo-cell.is-done{color:var(--so-ok)}
.so-demo-cell.is-partial{color:var(--so-warn)}
@media (max-width:760px){
.so-cells{grid-template-columns:repeat(2,minmax(0,1fr))}
.so-brand span{display:none}
.so-scroll{padding:12px 10px 32px}
}
`

    function insertStyles() {
      const mark = 'study-ops'
      if (document.querySelector('style[data-plugin-css="' + mark + '"]')) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = mark
      tag.dataset.pluginCss = mark
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ================================================================ *
     * small pieces
     * ================================================================ */

    const STATE_TEXT = { ok: '✓', warn: '!', bad: '✗', missing: '·', unknown: '—' }

    function StateDot({ state }) {
      return h('span', { className: 'so-state so-state-' + (state || 'missing'), title: state }, STATE_TEXT[state] || '·')
    }

    function Btn({ children, onClick, kind, disabled, title }) {
      return h('button', {
        type: 'button',
        className: 'so-btn ' + (kind ? 'so-btn-' + kind : 'so-btn-outline'),
        onClick,
        disabled,
        title
      }, children)
    }

    function FollowCell({ follow }) {
      if (!follow || follow.state === 'unknown') return h('span', { className: 'so-follow' }, '—')
      if (follow.state === 'done') return h('span', { className: 'so-follow' }, '已完成')
      if (follow.state === 'scheduled') return h('span', { className: 'so-follow' }, follow.due + ' 到期')
      if (follow.state === 'due') return h('span', { className: 'so-follow is-due' }, '今天/本周（' + follow.due + '）')
      return h('span', { className: 'so-follow is-overdue' }, '逾期 ' + Math.abs(follow.days) + ' 天')
    }

    function CellCard({ code, name, cell }) {
      const pct = Math.max(0, Math.min(100, Math.round((cell.n / Math.max(1, cell.target)) * 100)))
      return h('div', { className: 'so-cell' },
        h('div', { className: 'so-cell-head' },
          h('span', { className: 'so-cell-code' }, code),
          h('span', { className: 'so-cell-name' }, name),
          h('span', { className: 'so-cell-n' }, cell.n + '/' + cell.target)
        ),
        h('div', { className: 'so-bar' }, h('i', { style: { width: pct + '%' } }))
      )
    }

    const CELL_NAMES = { '11': 'MS·EFT', '12': 'MS·ERT', '21': 'DP·EFT', '22': 'DP·ERT' }

    /* ================================================================ *
     * schedule
     * ================================================================ */

    const PLAN_STATUS = { data: '数据已到', tested: '已登记', planned: '未到', missed: '未到' }

    function addDays(date, n) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''))
      if (!m) return ''
      const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000)
      return t.toISOString().slice(0, 10)
    }

    function ScheduleCard({ snap, onAdd, onRemove, busy }) {
      const tomorrow = addDays(snap.today, 1)
      const [id, setId] = useState('')
      const [date, setDate] = useState(tomorrow)
      const [start, setStart] = useState('')
      const [end, setEnd] = useState('')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      const padClock = value => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim())
        return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : ''
      }
      const clockMinutes = value => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim())
        return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60
      }

      const items = (snap.schedule || [])
        .filter(item => item.phase === 'today' || item.phase === 'future')
        .map(item => ({ ...item, start: padClock(item.start), end: padClock(item.end) }))
        .sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.start) - clockMinutes(b.start))

      const submit = () => {
        if (!/^\d{5}$/.test(id.trim())) {
          setError('编号要 5 位数字')
          return
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          setError('日期写成 YYYY-MM-DD')
          return
        }
        setError('')
        onAdd({ id: id.trim(), date, start: start.trim(), end: end.trim(), note: note.trim() })
        setId('')
        setStart('')
        setEnd('')
        setNote('')
      }

      return h('div', { className: 'so-plan' },
        h('div', { className: 'so-plan-head' },
          h('h4', null, '接下来两天的安排'),
          h('span', null, items.length ? items.length + ' 条' : '还没有安排')
        ),
        items.length
          ? h('div', { className: 'so-plan-list' },
              items.map(item => h('div', { className: 'so-plan-row', key: item.key || item.id + item.date },
                h('span', { className: 'so-plan-time' },
                  (item.phase === 'today' ? '今天 ' : item.date.slice(5) + ' ') +
                  (item.start ? item.start + (item.end ? '–' + item.end : '') : '')
                ),
                h('span', { className: 'so-plan-id' }, item.id),
                h('span', { className: 'so-note', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, item.note || ''),
                h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                  h('span', { className: 'so-plan-status is-' + item.status }, PLAN_STATUS[item.status] || item.status),
                  h('button', {
                    type: 'button',
                    className: 'so-btn so-btn-ghost so-btn-sm',
                    title: '删除这条安排',
                    disabled: busy,
                    onClick: () => onRemove(item.key)
                  }, '×')
                )
              ))
            )
          : h('div', { className: 'so-note' }, '把明天的编号、日期、时间段填在下面，明早打开就能对着做。'),
        h('div', { className: 'so-plan-form' },
          h('input', { className: 'so-in-id', placeholder: '编号', value: id, onChange: e => setId(e.target.value) }),
          h('input', { className: 'so-in-date', type: 'date', value: date, onChange: e => setDate(e.target.value) }),
          h('input', { className: 'so-in-time', placeholder: '10:00', value: start, onChange: e => setStart(e.target.value) }),
          h('input', { className: 'so-in-time', placeholder: '11:30', value: end, onChange: e => setEnd(e.target.value) }),
          h('input', {
            className: 'so-in-note',
            placeholder: '备注（可不填）',
            value: note,
            onChange: e => setNote(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') submit() }
          }),
          h(Btn, { kind: 'primary', onClick: submit, disabled: busy }, '加入安排'),
          error ? h('span', { className: 'so-flag' }, error) : null
        )
      )
    }

    /* ================================================================ *
     * detail
     * ================================================================ */

    function SessionBlock({ label, session }) {
      const s = session || {}
      return h('div', { className: 'so-kv-item' },
        h('span', null, label),
        h('b', null,
          h(StateDot, { state: s.state }),
          ' ',
          s.trials == null ? '—' : s.trials + ' 试次'
        ),
        s.rtMedian != null ? h('span', { className: 'so-note' }, 'RT 中位 ' + s.rtMedian + ' s' + (s.llRate != null ? '　LL ' + Math.round(s.llRate * 100) + '%' : '')) : null,
        s.timeouts ? h('span', { className: 'so-note' }, '超时重做 ' + s.timeouts + ' 次') : null
      )
    }

    function Detail({ detail, onFollowup, onT0, onClose, busy }) {
      const s = detail.subject
      const c = detail.contact || {}
      const [showContact, setShowContact] = useState(false)
      const [t0date, setT0date] = useState(s.t0 || '')
      return h('div', { className: 'so-detail' },
        h('div', { className: 'so-detail-head' },
          h('strong', { className: 'so-id' }, s.id),
          h('span', { className: 'so-note' }, '分组 ' + s.code + '　音频 ' + (s.audio || '—')),
          h('span', { className: 'so-note' }, 'T0 ' + (s.t0 || '—')),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
            s.t0 ? h(Btn, {
              kind: s.followup.state === 'done' ? 'outline' : 'primary',
              disabled: busy,
              onClick: () => onFollowup(s.id, s.followup.state !== 'done')
            }, s.followup.state === 'done' ? '撤销随访完成' : '标记随访完成') : null,
            h(Btn, { kind: 'ghost', onClick: onClose }, '收起')
          )
        ),
        h('div', { className: 'so-contact' },
          h('span', null, '联系方式'),
          showContact
            ? h('b', null, (c.name || '—') + (c.phone ? '　' + c.phone : ''))
            : h('span', null, '已隐藏'),
          h('button', {
            type: 'button',
            className: 'so-btn so-btn-ghost so-btn-sm',
            onClick: () => setShowContact(v => !v)
          }, showContact ? '隐藏' : '显示')
        ),
        h('div', { className: 'so-contact' },
          h('span', null, '人口学'),
          h('b', null, s.demo && s.demo.present ? s.demo.filled + ' / ' + s.demo.total + ' 项' : '还没有记录'),
          s.t0source && s.t0source !== 'data'
            ? h('span', null, '　T0 来自' + (s.t0source === 'schedule' ? '安排日期' : '手动填写'))
            : null
        ),
        h('div', { className: 'so-contact' },
          h('span', null, 'T0 日期'),
          h('input', {
            type: 'date',
            style: { height: '26px', padding: '0 6px', border: '1px solid var(--so-line)', borderRadius: '7px', background: 'var(--so-bg)', color: 'var(--so-text)', fontSize: '12px' },
            value: t0date,
            onChange: e => setT0date(e.target.value)
          }),
          h(Btn, { kind: 'outline', disabled: busy || !t0date, onClick: () => onT0(s.id, t0date) }, '保存 T0'),
          h('span', { className: 'so-note' }, '数据到了会以数据里的日期为准')
        ),
        h('div', { className: 'so-kv' },
          h(SessionBlock, { label: 'DDT · T0', session: s.sessions.T0 }),
          h(SessionBlock, { label: 'DDT · T1', session: s.sessions.T1 }),
          h(SessionBlock, { label: 'DDT · T2', session: s.sessions.T2 }),
          h(SessionBlock, { label: 'IDM · 1', session: s.idm.phase1 }),
          h(SessionBlock, { label: 'IDM · 2', session: s.idm.phase2 }),
          h(SessionBlock, { label: 'IDM · 3', session: s.idm.phase3 })
        ),
        s.flags && s.flags.length
          ? h('div', null, s.flags.map((f, i) => h('div', { className: 'so-flag', key: i }, '· ' + f)))
          : h('div', { className: 'so-note' }, '这一行没有硬性异常；随访状态看上表。')
      )
    }

    /* ================================================================ *
     * panel
     * ================================================================ */

    function hasIssue(s) {
      if (s.planned) return false
      if (s.flags && s.flags.length) return true
      return ['T0', 'T1', 'T2'].some(label => s.sessions[label].state === 'warn' || s.sessions[label].state === 'bad')
    }

    function Panel() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState('')
      const [filter, setFilter] = useState('all')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [showDismissed, setShowDismissed] = useState(false)

      const load = useCallback(async (force, silent) => {
        if (!silent) setLoading(true)
        setError('')
        try {
          const data = await call(force ? 'refresh' : 'status', force ? {} : undefined)
          setSnap(data)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          if (!silent) setLoading(false)
        }
      }, [])

      useEffect(() => { load(false) }, [load])

      // 改完名单、导入数据后，切回窗口会自动重扫；面板停留时每分钟也扫一次。
      useEffect(() => {
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          load(true, true)
        }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        const timer = setInterval(refresh, 60000)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
          clearInterval(timer)
        }
      }, [load])

      const openSubject = useCallback(async (id) => {
        setDetailError('')
        try {
          const data = await call('subject', undefined, { id })
          setDetail(data)
        } catch (e) {
          setDetailError(String(e && e.message ? e.message : e))
        }
      }, [])

      const markFollowup = useCallback(async (id, done) => {
        setBusy(true)
        try {
          await call('followup', { id, done })
          const data = await call('status', undefined)
          setSnap(data)
          if (detail && detail.subject.id === id) {
            const fresh = await call('subject', undefined, { id })
            setDetail(fresh)
          }
          setNotice(done ? id + ' 已标记随访完成' : id + ' 已撤销随访完成')
        } catch (e) {
          setNotice('操作失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [detail])

      const saveT0 = useCallback(async (id, date) => {
        setBusy(true)
        try {
          await call('t0', { id, date })
          setSnap(await call('status', undefined))
          setDetail(await call('subject', undefined, { id }))
          setNotice(id + ' 的 T0 记为 ' + date)
        } catch (e) {
          setNotice('T0 保存失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [])

      const exportReport = useCallback(async () => {
        setBusy(true)
        try {
          const data = await call('export', {})
          setNotice('已导出：' + data.files.map(f => f.name).join('、'))
        } catch (e) {
          setNotice('导出失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [])

      const openExportFolder = useCallback(async () => {
        try {
          await call('reveal', {})
        } catch {}
      }, [])

      const addPlan = useCallback(async payload => {
        setBusy(true)
        try {
          await call('schedule', { op: 'add', ...payload })
          setSnap(await call('status', undefined))
          setNotice(payload.id + ' 已加入 ' + payload.date)
        } catch (e) {
          setNotice('添加失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [])

      const removePlan = useCallback(async key => {
        setBusy(true)
        try {
          await call('schedule', { op: 'remove', key })
          setSnap(await call('status', undefined))
        } catch (e) {
          setNotice('删除失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [])

      const dismissAnomaly = useCallback(async key => {
        if (!key) return
        try {
          await call('dismiss', { key })
          setSnap(await call('status', undefined))
          setNotice('已忽略这条异常；在「查看已忽略」里可以恢复')
        } catch (e) {
          setNotice('忽略失败：' + String(e && e.message ? e.message : e))
        }
      }, [])

      const restoreAnomaly = useCallback(async key => {
        try {
          await call('restore', { key: key || '' })
          setSnap(await call('status', undefined))
          setNotice(key ? '已恢复这条异常' : '已恢复全部被忽略的异常')
        } catch (e) {
          setNotice('恢复失败：' + String(e && e.message ? e.message : e))
        }
      }, [])

      const subjects = useMemo(() => {
        if (!snap) return []
        const list = snap.subjects.slice()
        if (filter === 'issues') return list.filter(hasIssue)
        if (filter === 'followup') {
          return list.filter(s => s.followup.state === 'due' || s.followup.state === 'overdue')
        }
        return list
      }, [snap, filter])

      const issueCount = useMemo(() => (snap ? snap.subjects.filter(hasIssue).length : 0), [snap])

      if (!snap) {
        return h('div', { className: 'so-root' },
          h('div', { className: 'so-top' },
            h('div', { className: 'so-brand' }, h('strong', null, '实验运行台')),
            h('div', { className: 'so-top-right' }, h(Btn, { onClick: () => load(true), disabled: loading }, loading ? '扫描中…' : '重新扫描'))
          ),
          h('div', { className: 'so-scroll' },
            error
              ? h('div', { className: 'so-alert so-alert-bad' }, error)
              : h('div', { className: 'so-empty' }, h('strong', null, loading ? '正在扫描数据目录…' : '还没有数据'), h('p', null, '首次扫描会把 36 份 DDT 与 IDM 文件过一遍，之后走缓存。'))
          )
        )
      }

      const e = snap.enrollment
      const cells = e.cells || {}

      return h('div', { className: 'so-root' },
        h('div', { className: 'so-top' },
          h('div', { className: 'so-brand' },
            h('strong', null, '实验运行台'),
            h('span', null, snap.project)
          ),
          h('div', { className: 'so-top-right' },
            h('span', { className: 'so-note', title: '每次扫描都重新读名单和数据目录；只有新文件才重新质检' },
              '更新于 ' + new Date(snap.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })),
            h(Btn, { kind: 'ghost', onClick: () => load(true), disabled: loading }, loading ? '扫描中…' : '刷新'),
            h(Btn, { kind: 'outline', onClick: exportReport, disabled: busy }, '导出报告')
          )
        ),
        h('div', { className: 'so-scroll' },
          error ? h('div', { className: 'so-alert so-alert-bad' }, error) : null,
          notice ? h('div', { className: 'so-alert so-alert-ok' }, notice, h('button', {
            type: 'button', className: 'so-btn so-btn-ghost', style: { marginLeft: 'auto', height: '20px' }, onClick: () => setNotice('')
          }, '×')) : null,
          snap.qc && snap.qc.ok === false
            ? h('div', { className: 'so-alert so-alert-warn' }, '逐试次质检不可用：' + snap.qc.error + '（当前只按文件是否齐全判断）')
            : null,

          h('div', { className: 'so-progress' },
            h('div', { className: 'so-progress-main' },
              h('div', { className: 'so-big' }, e.n, h('small', null, '/ ' + snap.target.total)),
              h('div', { className: 'so-meta' },
                h('span', null, '名单登记 ', h('b', null, e.registered == null ? e.n : e.registered), ' 人'),
                e.pendingData ? h('span', null, '数据待导入 ', h('b', null, e.pendingData), ' 人') : null,
                h('span', null, '近 7 天 ', h('b', null, e.last7), ' 人'),
                h('span', null, '速度 ', h('b', null, e.pacePerDay), ' 人/天'),
                e.etaDate ? h('span', null, '预计 ', h('b', null, e.etaDate), ' 收完') : null,
                h('span', null, '人口学 ', h('b', null, (snap.demographics ? snap.demographics.done + '/' + (snap.demographics.done + snap.demographics.partial + snap.demographics.missing) : '—'))),
                h('span', null, '异常 ', h('b', null, snap.counts.bad), ' 高 / ', h('b', null, snap.counts.warn), ' 中'),
                h('span', null, '随访待办 ', h('b', null, snap.counts.followupDue + snap.counts.followupOverdue), ' 人')
              )
            ),
            h('div', { className: 'so-cells' },
              ['11', '12', '21', '22'].map(code => h(CellCard, { key: code, code, name: CELL_NAMES[code], cell: cells[code] || { n: 0, target: 32 } }))
            )
          ),

          h(ScheduleCard, { snap, onAdd: addPlan, onRemove: removePlan, busy }),

          h('div', { className: 'so-toolbar' },
            h('button', { type: 'button', className: 'so-chip' + (filter === 'all' ? ' is-active' : ''), onClick: () => setFilter('all') }, '全部 ', h('b', null, snap.subjects.length)),
            h('button', { type: 'button', className: 'so-chip' + (filter === 'issues' ? ' is-active' : ''), onClick: () => setFilter('issues') }, '有异常 ', h('b', null, issueCount)),
            h('button', { type: 'button', className: 'so-chip' + (filter === 'followup' ? ' is-active' : ''), onClick: () => setFilter('followup') }, '待随访 ', h('b', null, snap.counts.followupDue + snap.counts.followupOverdue))
          ),

          h('div', { className: 'so-table-wrap' },
            h('table', { className: 'so-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, '编号'), h('th', null, '分组'), h('th', null, '人口学'),
                  h('th', null, 'T0'), h('th', null, 'T1'), h('th', null, 'T2'),
                  h('th', null, 'IDM1'), h('th', null, 'IDM2'), h('th', null, 'IDM3'),
                  h('th', null, '随访')
                )
              ),
              h('tbody', null,
                subjects.map(s => h('tr', {
                  key: s.id,
                  className: detail && detail.subject.id === s.id ? 'is-open' : '',
                  onClick: () => openSubject(s.id)
                },
                  h('td', null,
                    h('span', { className: 'so-id' }, s.id),
                    s.pendingData ? h('span', { className: 'so-pending' }, '数据待导入') : null,
                    s.planned ? h('span', { className: 'so-scheduled' }, '待施测') : null
                  ),
                  h('td', null, s.code),
                  h('td', null, s.demo && s.demo.present
                    ? h('span', {
                        className: 'so-demo-cell' + (s.demo.filled >= s.demo.total ? ' is-done' : s.demo.filled > 0 ? ' is-partial' : ''),
                        title: '人口学 ' + s.demo.filled + ' / ' + s.demo.total
                      }, s.demo.filled + '/' + s.demo.total)
                    : h('span', { className: 'so-demo-cell', title: '还没有这位被试的人口学记录' }, '—')),
                  h('td', null, h(StateDot, { state: s.sessions.T0.state })),
                  h('td', null, h(StateDot, { state: s.sessions.T1.state })),
                  h('td', null, h(StateDot, { state: s.sessions.T2.state })),
                  h('td', null, h(StateDot, { state: s.idm.phase1.state })),
                  h('td', null, h(StateDot, { state: s.idm.phase2.state })),
                  h('td', null, h(StateDot, { state: s.idm.phase3.state })),
                  h('td', null, h(FollowCell, { follow: s.followup }))
                ))
              )
            )
          ),

          detailError ? h('div', { className: 'so-alert so-alert-warn', style: { marginTop: '12px' } }, detailError) : null,
          detail ? h(Detail, { key: detail.subject.id, detail, onFollowup: markFollowup, onT0: saveT0, onClose: () => setDetail(null), busy }) : null,

          h('div', { className: 'so-anomalies' },
            h('h4', null, '异常 ' + snap.anomalies.length + ' 条' +
              (snap.dismissed && snap.dismissed.length ? '　已忽略 ' + snap.dismissed.length + ' 条' : '')),
            snap.anomalies.length
              ? snap.anomalies.slice(0, 10).map((a, i) => h('div', { className: 'so-anom', key: a.key || i },
                  h('span', { className: 'so-lv ' + (a.level === 'bad' ? 'so-lv-bad' : 'so-lv-warn') }, a.level === 'bad' ? '高' : '中'),
                  h('div', { className: 'so-anom-body' },
                    h('button', { type: 'button', onClick: () => openSubject(a.id) }, a.id + '：' + a.text),
                    a.hint ? h('div', { className: 'so-anom-hint' }, a.hint) : null
                  ),
                  h('button', {
                    type: 'button',
                    className: 'so-btn so-btn-ghost so-btn-sm',
                    title: '这条看着没问题，收起来（随时能恢复）',
                    onClick: () => dismissAnomaly(a.key)
                  }, '忽略')
                ))
              : h('div', { className: 'so-note' }, '没有需要处理的异常。'),
            snap.anomalies.length > 10 ? h('div', { className: 'so-note' }, '还有 ' + (snap.anomalies.length - 10) + ' 条，导出报告里能看到全部。') : null,
            snap.dismissed && snap.dismissed.length
              ? h('div', { style: { marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed var(--so-line)' } },
                  h('button', {
                    type: 'button',
                    className: 'so-btn so-btn-ghost so-btn-sm',
                    onClick: () => setShowDismissed(v => !v)
                  }, (showDismissed ? '收起' : '查看') + '已忽略的 ' + snap.dismissed.length + ' 条'),
                  showDismissed
                    ? h('div', null,
                        snap.dismissed.map(d => h('div', { className: 'so-anom', key: d.key },
                          h('span', { className: 'so-lv' }, '忽略'),
                          h('span', { className: 'so-note' }, d.id + '：' + d.text + (d.note ? '（' + d.note + '）' : '')),
                          h('button', {
                            type: 'button',
                            className: 'so-btn so-btn-ghost so-btn-sm',
                            style: { marginLeft: 'auto' },
                            onClick: () => restoreAnomaly(d.key)
                          }, '恢复')
                        )),
                        h('button', {
                          type: 'button',
                          className: 'so-btn so-btn-ghost so-btn-sm',
                          onClick: () => restoreAnomaly('')
                        }, '全部恢复')
                      )
                    : null
                )
              : null
          ),

          h('div', { className: 'so-footer' },
            h('span', null, '扫描于 ' + new Date(snap.generatedAt).toLocaleString('zh-CN')),
            h('span', null, 'DDT ' + (snap.files ? snap.files.ddt : 0) + ' 份 · IDM ' + (snap.files ? snap.files.idm : 0) + ' 名'),
            h('span', null, snap.qc && snap.qc.ok ? ('质检：新解析 ' + snap.qc.parsed + '，缓存 ' + snap.qc.cached) : '质检：未启用'),
            h('button', { type: 'button', className: 'so-btn so-btn-ghost', style: { height: '18px', padding: '0 6px' }, onClick: openExportFolder }, '打开导出文件夹')
          )
        )
      )
    }

    /* ================================================================ *
     * icon + mounting
     * ================================================================ */

    function Icon({ size, active }) {
      const stroke = active ? 'currentColor' : 'currentColor'
      return h('svg', { width: size || 18, height: size || 18, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 3 }),
        h('path', { d: 'M8 8.5h8M8 12h5M8 15.5h3' }),
        h('path', { d: 'M14.5 16.2l1.6 1.6 3-3.2' })
      )
    }

    /**
     * 最外层护栏：面板组件在真实页面里抛错时，把错误显示在面板上，
     * 而不是让槽位把整个面板撤掉（那会变成一片空白，且看不到原因）。
     */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[study-ops] panel crashed:', error)
      }
      render() {
        if (this.state.error) {
          const text = String((this.state.error && (this.state.error.stack || this.state.error.message)) || this.state.error)
          return h('div', {
            style: {
              padding: '18px',
              fontFamily: 'ui-monospace,Consolas,monospace',
              fontSize: '12px',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              color: '#b00020',
              overflow: 'auto',
              height: '100%',
              boxSizing: 'border-box'
            }
          }, '实验运行台渲染失败：\n\n' + text + '\n\n（把这段发给我即可定位）')
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => insertStyles(), 'study-ops: styles')
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'study-ops', order: 31, label: '实验运行台' },
            props => h(Icon, { size: (props && props.size) || 18, active: Boolean(props && props.active) })
          )
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'study-ops' }, () => h(Guard, null, h(Panel))))
      }
    }
  }
})
