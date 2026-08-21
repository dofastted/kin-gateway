/**
 * Simplified Panel API — UI-friendly shapes for shadcn console.
 *
 * Envelope:
 *   { ok: true, data: T, meta?: object }
 *   { ok: false, error: { type, code, message, ... } }
 */

import os from 'node:os'
import path from 'node:path'
import { listVms, getVm, summarizeVm, getActiveVmId } from '../vm/vm-registry.mjs'
import { probeAccount } from '../oauth/usage-probe.mjs'
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { computeWeeklySplit, publicWeeklySplit, weeklySplitConfig } from '../pool/weekly-split.mjs'

export function ok(data, meta) {
  const out = { ok: true, data }
  if (meta) out.meta = meta
  return out
}

export function fail(errorResult) {
  // errorResult from makeError: { status, body: { error } }
  return {
    status: errorResult.status || 400,
    body: { ok: false, error: errorResult.body?.error || errorResult },
  }
}

export function buildDashboard({ cfg, accountQuota, stickyRouter, routingConfig, stats, requestLog = null, poolScheduler = null }) {
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const vms = listVms(cfg.paths.project).map((v) => enrichVm(v, accountQuota, active, { routingConfig, pool }))
  const snap = accountQuota.snapshot()
  const accounts = snap.accounts || []
  const peak5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)), 0)
  const peak7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)), 0)
  const near = accounts.filter(
    (a) =>
      Number(a.unified?.['5h']?.utilization || 0) >= (snap.safety_ratio || 0.95) ||
      Number(a.unified?.['7d']?.utilization || 0) >= (snap.safety_ratio || 0.95),
  ).length

  const billing = stampVmBilling(vms, (() => {
    try { return attachBillingMeta(requestLog?.billingStats?.(), accounts) } catch { return null }
  })())

  return ok({
    health: {
      status: 'ok',
      service: 'kin-gateway',
      rewrite: cfg.rewrite?.enabled ? 'on' : 'off',
      base_url: cfg.base_url,
    },
    host: hostStats(),
    summary: {
      vm_count: vms.length,
      account_count: accounts.length,
      active_vm: active,
      safety_ratio: snap.safety_ratio,
      peak_5h: peak5,
      peak_7d: peak7,
      near_limit: near,
      requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
      tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
      tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
      cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
      cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      fable_max_per_account: Number(routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4),
      fable_inflight: vms.reduce((n, v) => n + (Number(v.fable_inflight) || 0), 0),
      today_cost: billing?.today?.total_cost || 0,
      total_cost: billing?.total?.total_cost || 0,
    },
    vms,
    routing: {
      sticky_enabled: !!routingConfig?.sticky?.enabled,
      sticky_sessions: stickyRouter.stats()?.active_sessions ?? 0,
      safety_ratio: routingConfig?.quota?.safety_ratio ?? 0.95,
      fable_max_per_account: Number(routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4),
    },
    gateway_stats: stats,
    // historic totals straight from the request_logs table (survives restarts)
    db_totals: (() => { try { return requestLog?.totals() || null } catch { return null } })(),
    billing,
    // last-hour ops cards (SLA / QPS / TTFT) — console can refetch other windows via /request-logs/stats
    ops: (() => {
      try {
        return requestLog?.windowStats?.({ since: new Date(Date.now() - 3600_000).toISOString() }) || null
      } catch {
        return null
      }
    })(),
  })
}

export function buildVmList({ cfg, accountQuota, routingConfig = {}, poolScheduler = null }) {
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const vms = listVms(cfg.paths.project).map((v) => enrichVm(v, accountQuota, active, { routingConfig, pool }))
  return ok({ items: vms, active_vm: active, total: vms.length })
}

export function buildVmDetail({ cfg, accountQuota, id, routingConfig = {}, poolScheduler = null, requestLog = null }) {
  const vm = getVm(cfg.paths.project, id)
  if (!vm) {
    return fail(
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: `VM '${id}' not found`,
        status: 404,
      }),
    )
  }
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const summary = enrichVm(summarizeVm(vm), accountQuota, active, { routingConfig, pool })
  const acc = findAccount(accountQuota, summary)
  const billing = (() => { try { return requestLog?.billingStats?.() || null } catch { return null } })()
  const cost = lookupBilling(indexBillingAccounts(billing), acc || summary)
  if (cost) {
    summary.today_cost = cost.today_cost || 0
    summary.total_cost = cost.total_cost || 0
    summary.today_requests = cost.today_requests || 0
    summary.today_tokens = (cost.today_input_tokens || 0) + (cost.today_output_tokens || 0)
    summary.window_5h_cost = cost.window_5h_cost || 0
    summary.window_5h_requests = cost.window_5h_requests || 0
    summary.window_5h_tokens = cost.window_5h_tokens || 0
  }
  return ok({
    vm: summary,
    billing: cost
      ? {
          source: billing?.source || 'anthropic-official',
          currency: billing?.currency || 'USD',
          today_cost: cost.today_cost || 0,
          total_cost: cost.total_cost || 0,
          window_5h_cost: cost.window_5h_cost || 0,
          today_requests: cost.today_requests || 0,
          requests: cost.requests || 0,
          input_cost: cost.input_cost || 0,
          output_cost: cost.output_cost || 0,
          cache_cost: (cost.cache_read_cost || 0) + (cost.cache_creation_cost || 0),
        }
      : null,
    account: acc
      ? {
          account_id: acc.account_id,
          ...quotaFromAccount(acc, accountQuota?.config),
          inflight: acc.inflight,
          max_concurrency: acc.max_concurrency,
          requests: acc.requests,
          tokens_in: acc.tokens_in,
          tokens_out: acc.tokens_out,
          cache_read_tokens: acc.cache_read_tokens || 0,
          cache_creation_tokens: acc.cache_creation_tokens || 0,
          today_cost: cost?.today_cost || 0,
          total_cost: cost?.total_cost || 0,
          window_5h_cost: cost?.window_5h_cost || 0,
          last_blocked: acc.last_blocked,
          recent: (acc.recent_allocations || []).slice(-10),
          runtime_window: runtimeWindow(accountQuota, acc.account_id),
        }
      : null,
  })
}

/** Structured session-window / rate-limit state from account_runtime_states. */
function runtimeWindow(accountQuota, accountId) {
  try {
    const state = accountQuota?.runtimeRepo?.get?.(accountId)
    if (!state) return null
    return {
      rate_limited_at: state.rate_limited_at,
      rate_limit_reset_at: state.rate_limit_reset_at,
      overload_until: state.overload_until,
      session_window_start: state.session_window_start,
      session_window_end: state.session_window_end,
      session_window_status: state.session_window_status,
    }
  } catch {
    return null
  }
}

export async function buildProbeOne({ cfg, accountQuota, id }) {
  const vm = getVm(cfg.paths.project, id)
  if (!vm) {
    return fail(
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: `VM '${id}' not found`,
        status: 404,
      }),
    )
  }
  if (!vm.claude?.access_token) {
    return fail(
      makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'no_oauth_token',
        message: 'VM has no OAuth access token',
        status: 400,
      }),
    )
  }
  const exec = {
    vmId: vm.id,
    homeDir: path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
    oauth: vm.claude,
    vm,
  }
  const result = await probeAccount({ exec, vm, includeFable: true })
  const accountId = vm.claude?.account_uuid || vm.id
  accountQuota.ensure({
    account_id: accountId,
    vm_id: vm.id,
    email: vm.claude?.email,
    max_concurrency: vm.policy?.maxConcurrency,
  })
  if (result.five_hour || result.seven_day || result.seven_day_oi || result.fable) {
    accountQuota.ingestOAuthUsage(accountId, result)
  }
  return ok({
    vm_id: id,
    account_uuid: vm.claude?.account_uuid || null,
    source: result.source,
    via: result.via || null,
    five_hour: result.five_hour || null,
    seven_day: result.seven_day || null,
    seven_day_sonnet: result.seven_day_sonnet || null,
    seven_day_oi: result.seven_day_oi || null,
    extra_usage: result.extra_usage || null,
    fable: result.fable || null,
    probed_at: result.probed_at,
    ok: result.ok,
    error: result.error || result.usage_error || null,
  })
}

export async function buildProbeAll({ cfg, accountQuota }) {
  const vms = listVms(cfg.paths.project)
  const items = []
  for (const s of vms) {
    const one = await buildProbeOne({ cfg, accountQuota, id: s.id })
    if (one.ok === false || one.status) {
      items.push({ vm_id: s.id, ok: false, error: one.body?.error || one })
    } else {
      items.push(one.data)
    }
  }
  return ok({ items, total: items.length })
}

export function buildUsage({ accountQuota, cfg, requestLog = null }) {
  const snap = accountQuota.snapshot()
  const billing = (() => { try { return requestLog?.billingStats?.() || null } catch { return null } })()
  const costByKey = indexBillingAccounts(billing)
  const accounts = (snap.accounts || []).map((a) => {
    const cost = lookupBilling(costByKey, a)
    return {
      account_id: a.account_id,
      vm_id: a.vm_id,
      email: a.email,
      ...quotaFromAccount(a, accountQuota?.config),
      inflight: a.inflight,
      max_concurrency: a.max_concurrency,
      requests: a.requests,
      tokens_in: a.tokens_in,
      tokens_out: a.tokens_out,
      cache_read_tokens: a.cache_read_tokens || 0,
      cache_creation_tokens: a.cache_creation_tokens || 0,
      today_cost: cost?.today_cost || 0,
      total_cost: cost?.total_cost || 0,
      window_5h_cost: cost?.window_5h_cost || 0,
      window_5h_requests: cost?.window_5h_requests || 0,
      window_5h_tokens: cost?.window_5h_tokens || 0,
      input_cost: cost?.input_cost || 0,
      output_cost: cost?.output_cost || 0,
      cache_cost: (cost?.cache_read_cost || 0) + (cost?.cache_creation_cost || 0),
      near_limit:
        Number(a.unified?.['5h']?.utilization || 0) >= (snap.safety_ratio || 0.95) ||
        Number(a.unified?.['7d']?.utilization || 0) >= (snap.safety_ratio || 0.95),
    }
  })
  return ok({
    safety_ratio: snap.safety_ratio,
    billing: attachBillingMeta(billing, snap.accounts || []),
    accounts,
    totals: {
      requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
      tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
      tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
      cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
      cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      today_cost: billing?.today?.total_cost || 0,
      total_cost: billing?.total?.total_cost || 0,
      peak_5h: Math.max(0, ...accounts.map((a) => a.utilization_5h), 0),
      peak_7d: Math.max(0, ...accounts.map((a) => a.utilization_7d), 0),
      near_limit: accounts.filter((a) => a.near_limit).length,
    },
  })
}

export function buildRouting({ routingConfig, stickyRouter }) {
  return ok({
    sticky: routingConfig?.sticky || {},
    quota: routingConfig?.quota || {},
    concurrency: routingConfig?.concurrency || {},
    logging: routingConfig?.logging || {},
    pool: routingConfig?.pool || {},
    failover: routingConfig?.failover || {},
    compatibility: routingConfig?.compatibility || {},
    sessions: stickyRouter.stats(),
  })
}

function hostStats() {
  const cpus = os.cpus() || []
  const n = cpus.length || 1
  const [load1, load5, load15] = os.loadavg()
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  const mem = process.memoryUsage()
  return {
    cpu_count: n,
    load1,
    load5,
    load15,
    cpu_pct: Math.round(Math.min(100, (load1 / n) * 1000) / 10),
    mem_total: total,
    mem_free: free,
    mem_used: used,
    mem_pct: total ? Math.round((used / total) * 1000) / 10 : 0,
    rss: mem.rss,
    heap_used: mem.heapUsed,
    heap_total: mem.heapTotal,
    uptime: os.uptime(),
    proc_uptime: process.uptime(),
  }
}


function quotaFromAccount(acc, quotaConfig) {
  const u = acc?.unified || {}
  const w5 = u['5h'] || {}
  const w7 = u['7d'] || {}
  const sonnet = u.seven_day_sonnet || {}
  const oi = u['7d_oi'] || {}
  const fable = u.fable || null
  const extra = u.extra_usage || null
  const q = {
    utilization_5h: w5.utilization != null ? Number(w5.utilization) : null,
    utilization_7d: w7.utilization != null ? Number(w7.utilization) : null,
    utilization_7d_sonnet: sonnet.utilization != null ? Number(sonnet.utilization) : null,
    utilization_7d_oi: oi.utilization != null ? Number(oi.utilization) : (fable?.utilization != null ? Number(fable.utilization) : null),
    reset_5h: w5.reset || null,
    reset_7d: w7.reset || null,
    reset_7d_sonnet: sonnet.reset || null,
    reset_7d_oi: oi.reset || null,
    status_5h: w5.status || null,
    status_7d: w7.status || null,
    status_7d_sonnet: sonnet.status || null,
    status_7d_oi: oi.status || null,
    extra_usage: extra,
    fable: fable,
    last_probe: acc?.last_probe || u.last_probe || null,
    probe_source: u.source || acc?.last_probe?.source || null,
  }
  const cfg = weeklySplitConfig(quotaConfig || {})
  const split = publicWeeklySplit(computeWeeklySplit({
    enabled: cfg.enabled,
    fable_share: cfg.fable_share,
    utilization_7d: q.utilization_7d,
    utilization_7d_oi: q.utilization_7d_oi,
    status_7d_oi: q.status_7d_oi,
  }))
  if (split) q.weekly_split = split
  return q
}

function fablePoolFields(acc, runtime, pool = {}, routingConfig = {}, vm = {}) {
  const keys = [acc?.account_id, vm.account_uuid, vm.id].filter(Boolean)
  let family = {}
  for (const key of keys) {
    if (pool.inflight_family?.[key]) {
      family = pool.inflight_family[key]
      break
    }
  }
  const fableMax = Number(routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4)
  const states = runtime?.model_states || {}
  const fableState = states.fable || states['claude-fable-5'] || null
  const until = Number(fableState?.cooldown_until) || 0
  return {
    fable_inflight: Number(family.fable || 0) || 0,
    fable_max: Number.isFinite(fableMax) && fableMax > 0 ? fableMax : 4,
    fable_cooldown_until: until > Date.now() ? until : null,
    fable_cooldown_reason: until > Date.now() ? (fableState?.reason || null) : null,
  }
}



function expiresAtToMs(expiresAt) {
  if (expiresAt == null || expiresAt === '') return 0
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt
  }
  const str = String(expiresAt).trim()
  if (!str) return 0
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const parsed = Date.parse(str)
  return Number.isFinite(parsed) ? parsed : 0
}

export function credStatusFromQuota(hasToken, q = {}, expiresAt = null, extras = {}) {
  if (!hasToken) return { key: 'none', text: '无凭证', tone: 'none' }
  const fb = q.fable || {}
  const lastProbe = q.last_probe || {}
  const probeAt = Date.parse(fb.probed_at || lastProbe.at || '')
  const refreshedAt = Date.parse(extras.refreshed_at || extras.oauth_refreshed_at || '')
  const probeStale = Number.isFinite(probeAt) && Number.isFinite(refreshedAt) && probeAt < refreshedAt
  // Go worker is the refresh owner. Prefer its live credential over stale vm.json expires_at.
  const worker = extras.worker_credential || extras.worker || null
  const workerLive = !!(worker && worker.has_access && worker.needs_refresh === false)
  const expMs = expiresAtToMs(expiresAt)
  if (!workerLive && expMs && expMs <= Date.now()) return { key: 'bad', text: '不可用', tone: 'bad' }
  // Ignore fable.banned from a probe that ran before the current token was written.
  if (fb.banned && !probeStale) return { key: 'bad', text: '被吊销', tone: 'bad' }
  const utilPct = (u) => {
    if (u == null) return 0
    const n = Number(u)
    return n > 1.5 ? n : n * 100
  }
  const limited = (st, pct) => {
    const s = String(st || '').toLowerCase()
    return s === 'rejected' || s === 'rate_limited' || pct >= 100
  }
  const warn = (st, pct) => {
    const s = String(st || '').toLowerCase()
    return s === 'allowed_warning' || s === 'warning' || pct >= 85
  }
  const p5 = utilPct(q.utilization_5h)
  const p7 = utilPct(q.utilization_7d)
  if (limited(q.status_5h, p5)) return { key: 'warn', text: '5h 限制', tone: 'warn' }
  if (limited(q.status_7d, p7)) return { key: 'warn', text: '7d 限制', tone: 'warn' }
  if (warn(q.status_5h, p5)) return { key: 'caution', text: '5h 警告', tone: 'caution' }
  if (warn(q.status_7d, p7)) return { key: 'caution', text: '7d 警告', tone: 'caution' }
  const split = q.weekly_split
  if (split?.enabled && split.mode === 'fable_only') return { key: 'warn', text: '普通限制', tone: 'warn' }
  if (split?.enabled && split.mode === 'regular_only') return { key: 'warn', text: 'Fable 限制', tone: 'warn' }
  // Real Anthropic fable 429 beats a later SOCKS transport failure.
  if (limited(q.status_7d_oi, utilPct(q.utilization_7d_oi))) return { key: 'warn', text: 'Fable 限制', tone: 'warn' }
  if (fb.limited && !fb.transport && q.utilization_7d_oi == null) return { key: 'warn', text: 'Fable 限制', tone: 'warn' }
  if (extras.fable_cooldown_until && Number(extras.fable_cooldown_until) > Date.now()) {
    return { key: 'warn', text: 'Fable 冷却', tone: 'warn' }
  }
  const transportFail = !!(lastProbe.transport || fb.transport)
    || (lastProbe.ok === false && /SOCKS|transport|greeting|reset by peer|worker_error/i.test(String(lastProbe.error || fb.error || '')))
  if (transportFail) return { key: 'warn', text: '探测失败', tone: 'warn' }
  return { key: 'ok', text: '可用', tone: 'ok' }
}

function enrichVm(v, accountQuota, active, extras = {}) {
  const acc = findAccount(accountQuota, v)
  const runtime = findRuntime(accountQuota, v)
  const workerCred = runtime?.worker_status?.credential || null
  const q = quotaFromAccount(acc, accountQuota?.config)
  const fablePool = fablePoolFields(acc, runtime, extras.pool || {}, extras.routingConfig || {}, v)
  const u5 = q.utilization_5h
  const u7 = q.utilization_7d
  const safety = Number(accountQuota?.config?.safety_ratio || 0.95)
  // Align display expires_at with the Go worker when it has a newer TTL.
  let expiresAt = v.expires_at || null
  if (workerCred?.expires_at != null) {
    const wMs = expiresAtToMs(workerCred.expires_at)
    const vMs = expiresAtToMs(v.expires_at)
    if (wMs > vMs) expiresAt = workerCred.expires_at
  }
  const hasToken = !!(v.has_token || workerCred?.has_access)
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    active: v.id === active,
    kernel: v.kernel || null,
    note: v.note || null,
    region: v.region || null,
    timezone: v.timezone || null,
    locale: v.locale || null,
    email: v.email,
    account_uuid: v.account_uuid,
    org_uuid: v.org_uuid || null,
    has_token: hasToken,
    access_preview: v.access_preview || null,
    refresh_preview: v.refresh_preview || null,
    expires_at: expiresAt,
    oauth_source: v.oauth_source || null,
    has_refresh: !!(v.has_refresh || workerCred?.has_refresh),
    has_session_key: !!v.has_session_key,
    proxy: v.proxy || null,
    proxy_id: v.proxy_id || v.proxy?.id || null,
    proxy_cli_enabled: !!v.proxy_cli_enabled,
    seed_policy: v.seed_policy || null,
    max_concurrency: v.max_concurrency,
    weight: v.weight ?? 1,
    claude_code_version: v.claude_code_version,
    utilization_5h: u5,
    utilization_7d: u7,
    utilization_7d_sonnet: q.utilization_7d_sonnet,
    utilization_7d_oi: q.utilization_7d_oi,
    reset_5h: q.reset_5h,
    reset_7d: q.reset_7d,
    reset_7d_sonnet: q.reset_7d_sonnet,
    reset_7d_oi: q.reset_7d_oi,
    status_5h: q.status_5h,
    status_7d: q.status_7d,
    status_7d_sonnet: q.status_7d_sonnet,
    status_7d_oi: q.status_7d_oi,
    ...(q.weekly_split ? { weekly_split: q.weekly_split } : {}),
    fable_inflight: fablePool.fable_inflight,
    fable_max: fablePool.fable_max,
    fable_cooldown_until: fablePool.fable_cooldown_until,
    fable_cooldown_reason: fablePool.fable_cooldown_reason,
    extra_usage: q.extra_usage,
    fable: q.fable,
    last_probe: q.last_probe,
    probe_source: q.probe_source,
    refreshed_at: v.refreshed_at || null,
    refresh_status: runtime?.refresh_status || null,
    worker_credential: workerCred
      ? {
          has_access: !!workerCred.has_access,
          has_refresh: !!workerCred.has_refresh,
          needs_refresh: !!workerCred.needs_refresh,
          expires_at: workerCred.expires_at ?? null,
          ttl_seconds: workerCred.ttl_seconds ?? null,
          generation: workerCred.generation ?? null,
        }
      : null,
    cred_status: credStatusFromQuota(hasToken, q, expiresAt, {
      refreshed_at: v.refreshed_at || null,
      worker_credential: workerCred,
      fable_cooldown_until: fablePool.fable_cooldown_until,
    }),
    inflight: acc?.inflight ?? 0,
    requests: acc?.requests ?? v.stats?.requests ?? 0,
    tokens_in: acc?.tokens_in ?? 0,
    tokens_out: acc?.tokens_out ?? 0,
    near_limit: u5 != null && (u5 >= safety || (u7 != null && u7 >= safety)),
    fingerprint: v.fingerprint || null,
    runtime: v.runtime || null,
    ip: v.ip || v.runtime?.ip || null,
    pid: v.pid || v.runtime?.pid || null,
    container: v.container || v.runtime?.container || null,
    schedulable: v.schedulable !== false,
    created_at: v.created_at || null,
  }
}

function findAccount(accountQuota, vm) {
  const snap = accountQuota.snapshot()
  return (snap.accounts || []).find(
    (a) => a.vm_id === vm.id || a.account_id === vm.account_uuid,
  )
}

function findRuntime(accountQuota, vm) {
  try {
    const repo = accountQuota?.runtimeRepo
    if (!repo?.get) return null
    const acc = findAccount(accountQuota, vm)
    const keys = [vm.account_uuid, acc?.account_id, vm.id].filter(Boolean)
    for (const key of keys) {
      const state = repo.get(key)
      if (state) return state
    }
  } catch {}
  return null
}

function indexBillingAccounts(billing) {
  const map = new Map()
  for (const row of billing?.accounts || []) {
    if (row.account_id) map.set('id:' + row.account_id, row)
    if (row.vm_id) map.set('vm:' + row.vm_id, row)
  }
  return map
}

function lookupBilling(index, accOrVm) {
  if (!index || !accOrVm) return null
  const keys = [
    accOrVm.account_id && 'id:' + accOrVm.account_id,
    accOrVm.account_uuid && 'id:' + accOrVm.account_uuid,
    accOrVm.vm_id && 'vm:' + accOrVm.vm_id,
    accOrVm.id && 'vm:' + accOrVm.id,
  ].filter(Boolean)
  for (const k of keys) {
    if (index.has(k)) return index.get(k)
  }
  return null
}

function attachBillingMeta(billing, accounts = []) {
  if (!billing) return null
  const labeled = (billing.accounts || []).map((row) => {
    const acc = (accounts || []).find(
      (a) => a.account_id === row.account_id || a.vm_id === row.vm_id,
    )
    return {
      ...row,
      email: acc?.email || row.email || null,
    }
  })
  return {
    source: billing.source || 'anthropic-official',
    currency: billing.currency || 'USD',
    today_start: billing.today_start,
    window_5h_start: billing.window_5h_start,
    today: billing.today,
    window_5h: billing.window_5h,
    total: billing.total,
    accounts: labeled,
  }
}

function stampVmBilling(vms, billing) {
  if (!billing) return null
  const index = indexBillingAccounts(billing)
  for (const vm of vms || []) {
    const cost = lookupBilling(index, vm)
    vm.today_cost = cost?.today_cost || 0
    vm.total_cost = cost?.total_cost || 0
    vm.today_requests = cost?.today_requests || 0
    vm.today_tokens = (cost?.today_input_tokens || 0) + (cost?.today_output_tokens || 0)
    vm.window_5h_cost = cost?.window_5h_cost || 0
    vm.window_5h_requests = cost?.window_5h_requests || 0
    vm.window_5h_tokens = cost?.window_5h_tokens || 0
  }
  return billing
}
