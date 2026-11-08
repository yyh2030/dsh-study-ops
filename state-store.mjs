import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const queues = new Map()
export const fail = (message, code = 'invalid') => Object.assign(new Error(message), { code })
export async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    if (!state || typeof state !== 'object' || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('状态结构无效')
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: 0, schedules: [], followups: {}, dismissed: {} }
    throw fail('状态文件读取失败：' + error.message, 'state_error')
  }
}
export async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' }); await rename(temp, file) }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export function mutateState(file, expected, operation) {
  if (!Number.isSafeInteger(expected) || expected < 0) return Promise.reject(fail('请先刷新取得 stateRevision 后再保存', 'conflict'))
  const key = path.resolve(file)
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    let lock
    try { lock = await open(file + '.lock', 'wx') }
    catch (error) { if (error.code === 'EEXIST') throw fail('另一项写入正在进行，请刷新后重试', 'conflict'); throw error }
    try {
      const state = await readState(file)
      if (state.revision !== expected) throw fail('状态已更新，请刷新后重试；草稿尚未保存', 'conflict')
      const result = await operation(state)
      state.revision++
      await atomicWrite(file, state)
      return { result, stateRevision: state.revision }
    } finally { await lock.close(); await unlink(file + '.lock') }
  })
  queues.set(key, next)
  next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}
