export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false
  const src = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) { if (c === '"') { if (src[i + 1] === '"') { field += c; i++ } else quoted = false } else field += c }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => v.trim()))
}
export function csvObjects(text) {
  const rows = parseCsv(text); if (!rows.length) return []
  const header = rows.shift().map(v => v.trim())
  if (new Set(header).size !== header.length || header.some(v => !v)) throw new Error('CSV 表头为空或重复')
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`CSV 第 ${index + 2} 行列数与表头不一致`)
    return Object.fromEntries(header.map((key, i) => [key, row[i]]))
  })
}
export const encodeCsv = rows => '\ufeff' + rows.map(row => row.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n')
