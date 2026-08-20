/**
 * Experimental weekly quota split: Fable vs regular models each get
 * `fable_share` of the official 7d pool (default 50/50).
 *
 * Calibrated from Anthropic tables only (7d + 7d_oi). No local token ledger.
 *   fableUsed    = uOi * share          // 7d_oi full  ==  half of weekly
 *   regularUsed  = max(0, u7 - fableUsed)
 * Off by default; callers must honor `enabled`.
 */

export const DEFAULT_FABLE_SHARE = 0.5

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

export function normalizeUtil(v) {
  if (v == null || v === '') return null
  const x = Number(v)
  if (!Number.isFinite(x)) return null
  return clamp01(x > 1.5 ? x / 100 : x)
}

export function weeklySplitConfig(quota = {}) {
  const raw = quota?.weekly_split && typeof quota.weekly_split === 'object'
    ? quota.weekly_split
    : {}
  const share = Number(raw.fable_share)
  return {
    enabled: raw.enabled === true,
    fable_share: Number.isFinite(share) && share > 0 && share < 1 ? share : DEFAULT_FABLE_SHARE,
  }
}

export function computeWeeklySplit({
  utilization_7d,
  utilization_7d_oi,
  status_7d_oi,
  fable_share = DEFAULT_FABLE_SHARE,
  enabled = true,
} = {}) {
  const share = Number.isFinite(Number(fable_share)) && Number(fable_share) > 0 && Number(fable_share) < 1
    ? Number(fable_share)
    : DEFAULT_FABLE_SHARE
  const u7 = normalizeUtil(utilization_7d) ?? 0
  const uOi = normalizeUtil(utilization_7d_oi) ?? 0
  const oiRejected = ['rejected', 'rate_limited'].includes(String(status_7d_oi || '').toLowerCase())
  const fableUsed = Math.min(share, Math.max(0, uOi * share))
  const regularUsed = Math.min(1, Math.max(0, u7 - fableUsed))
  const fableRemain = Math.max(0, share - fableUsed)
  const regularRemain = Math.max(0, share - regularUsed)
  const fableBlocked = !!enabled && (fableRemain <= 1e-9 || oiRejected || uOi >= 1)
  const regularBlocked = !!enabled && regularRemain <= 1e-9
  let mode = 'open'
  if (enabled) {
    if (regularBlocked && !fableBlocked) mode = 'fable_only'
    else if (fableBlocked && !regularBlocked) mode = 'regular_only'
    else if (regularBlocked && fableBlocked) mode = 'fable_only'
  }
  return {
    enabled: !!enabled,
    fable_share: share,
    fable_used_weekly: fableUsed,
    regular_used_weekly: regularUsed,
    fable_remain_weekly: fableRemain,
    regular_remain_weekly: regularRemain,
    fable_blocked: fableBlocked,
    regular_blocked: regularBlocked,
    mode,
  }
}

export function publicWeeklySplit(split) {
  if (!split?.enabled) return null
  return {
    enabled: true,
    fable_share: split.fable_share,
    fable_used_weekly: split.fable_used_weekly,
    regular_used_weekly: split.regular_used_weekly,
    fable_remain_weekly: split.fable_remain_weekly,
    regular_remain_weekly: split.regular_remain_weekly,
    mode: split.mode,
  }
}

/** @returns {'fable_split'|'regular_split'|null} */
export function splitBlocksModel(split, model) {
  if (!split?.enabled) return null
  const fable = String(model || '').toLowerCase().includes('fable')
  if (fable && split.fable_blocked) return 'fable_split'
  if (!fable && split.regular_blocked) return 'regular_split'
  return null
}
