/**
 * One in-process panel job at a time (研报压测 / 能力探针).
 * Only vm-01 has a live credential; stacking jobs burns the same slot.
 */

let current = null

export function getTestJob() {
  return current ? { ...current } : null
}

export function isTestJobBusy() {
  return !!(current && (current.status === 'running' || current.status === 'cancelling'))
}

export function beginTestJob(kind, id) {
  if (isTestJobBusy()) {
    return { ok: false, current: { ...current } }
  }
  current = {
    kind: String(kind || 'job'),
    id: String(id || ''),
    status: 'running',
    started_at: new Date().toISOString(),
  }
  return { ok: true, current: { ...current } }
}

export function markTestJob(id, status) {
  if (current?.id === id) current = { ...current, status: String(status || current.status) }
}

export function endTestJob(id) {
  if (!id || current?.id === id) current = null
}

export function busyMessage(currentJob = current) {
  if (!currentJob) return '已有任务在运行'
  if (currentJob.kind === 'probe') return '已有能力/答题探针在运行，请等待结束或取消'
  if (currentJob.kind === 'loadtest') return '已有研报压测在运行，请等待结束或取消'
  return '已有任务在运行，请等待结束或取消'
}
