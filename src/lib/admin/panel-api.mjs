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

export function buildDashboard({ cfg, accountQuota, stickyRouter, routingConfig, stats, requestLog = null }) {
  const active = getActiveVmId(cfg.paths.project)
  const vms = listVms(cfg.paths.project).map((v) => enrichVm(v, accountQuota, active))
  const snap = accountQuota.snapshot()
  const accounts = snap.accounts || []
  const peak5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)), 0)
  const peak7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)), 0)
  const near = accounts.filter(
    (a) =>
      Number(a.unified?.['5h']?.utilization || 0) >= (snap.safety_ratio || 0.95) ||
      Number(a.unified?.['7d']?.utilization || 0) >= (snap.safety_ratio || 0.95),
  ).length

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
    },
    vms,
    routing: {
      sticky_enabled: !!routingConfig?.sticky?.enabled,
      sticky_sessions: stickyRouter.stats()?.active_sessions ?? 0,
      safety_ratio: routingConfig?.quota?.safety_ratio ?? 0.95,
    },
    gateway_stats: stats,
    // historic totals straight from the request_logs table (survives restarts)
    db_totals: (() => { try { return requestLog?.totals() || null } catch { return null } })(),
  })
}

export function buildVmList({ cfg, accountQuota }) {
  const active = getActiveVmId(cfg.paths.project)
  const vms = listVms(cfg.paths.project).map((v) => enrichVm(v, accountQuota, active))
  return ok({ items: vms, active_vm: active, total: vms.length })
}

export function buildVmDetail({ cfg, accountQuota, id }) {
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
  const summary = enrichVm(summarizeVm(vm), accountQuota, active)
  const acc = findAccount(accountQuota, summary)
  return ok({
    vm: summary,
    account: acc
      ? {
          account_id: acc.account_id,
          ...quotaFromAccount(acc),
          inflight: acc.inflight,
          max_concurrency: acc.max_concurrency,
          requests: acc.requests,
          tokens_in: acc.tokens_in,
          tokens_out: acc.tokens_out,
          last_blocked: acc.last_blocked,
          recent: (acc.recent_allocations || []).slice(-10),
        }
      : null,
  })
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
  if (result.five_hour || result.seven_day || result.fable) {
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

export function buildUsage({ accountQuota, cfg }) {
  const snap = accountQuota.snapshot()
  const accounts = (snap.accounts || []).map((a) => ({
    account_id: a.account_id,
    vm_id: a.vm_id,
    email: a.email,
    ...quotaFromAccount(a),
    inflight: a.inflight,
    max_concurrency: a.max_concurrency,
    requests: a.requests,
    tokens_in: a.tokens_in,
    tokens_out: a.tokens_out,
    near_limit:
      Number(a.unified?.['5h']?.utilization || 0) >= (snap.safety_ratio || 0.95) ||
      Number(a.unified?.['7d']?.utilization || 0) >= (snap.safety_ratio || 0.95),
  }))
  return ok({
    safety_ratio: snap.safety_ratio,
    accounts,
    totals: {
      requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
      tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
      tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
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


function quotaFromAccount(acc) {
  const u = acc?.unified || {}
  const w5 = u['5h'] || {}
  const w7 = u['7d'] || {}
  const sonnet = u.seven_day_sonnet || {}
  const fable = u.fable || null
  const extra = u.extra_usage || null
  return {
    utilization_5h: w5.utilization != null ? Number(w5.utilization) : null,
    utilization_7d: w7.utilization != null ? Number(w7.utilization) : null,
    utilization_7d_sonnet: sonnet.utilization != null ? Number(sonnet.utilization) : null,
    reset_5h: w5.reset || null,
    reset_7d: w7.reset || null,
    reset_7d_sonnet: sonnet.reset || null,
    status_5h: w5.status || null,
    status_7d: w7.status || null,
    status_7d_sonnet: sonnet.status || null,
    extra_usage: extra,
    fable: fable,
    last_probe: acc?.last_probe || null,
    probe_source: u.source || acc?.last_probe?.source || null,
  }
}


function credStatusFromQuota(hasToken, q = {}, expiresAt = null) {
  if (!hasToken) return { key: 'none', text: '无凭证', tone: 'none' }
  const fb = q.fable || {}
  if (fb.banned) return { key: 'bad', text: '不可用', tone: 'bad' }
  if (expiresAt) {
    const ms = Date.parse(expiresAt)
    if (Number.isFinite(ms) && ms <= Date.now()) return { key: 'bad', text: '不可用', tone: 'bad' }
  }
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
  if (limited(q.status_5h, p5) || warn(q.status_5h, p5)) return { key: 'warn', text: '5h 限制', tone: 'warn' }
  if (limited(q.status_7d, p7) || warn(q.status_7d, p7)) return { key: 'warn', text: '7d 限制', tone: 'warn' }
  if (fb.limited) return { key: 'warn', text: 'Fable 限制', tone: 'warn' }
  return { key: 'ok', text: '可用', tone: 'ok' }
}

function enrichVm(v, accountQuota, active) {
  const acc = findAccount(accountQuota, v)
  const q = quotaFromAccount(acc)
  const u5 = q.utilization_5h
  const u7 = q.utilization_7d
  const safety = Number(accountQuota?.config?.safety_ratio || 0.95)
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
    has_token: v.has_token,
    expires_at: v.expires_at || null,
    oauth_source: v.oauth_source || null,
    has_refresh: !!v.has_refresh,
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
    reset_5h: q.reset_5h,
    reset_7d: q.reset_7d,
    reset_7d_sonnet: q.reset_7d_sonnet,
    status_5h: q.status_5h,
    status_7d: q.status_7d,
    status_7d_sonnet: q.status_7d_sonnet,
    extra_usage: q.extra_usage,
    fable: q.fable,
    last_probe: q.last_probe,
    probe_source: q.probe_source,
    cred_status: credStatusFromQuota(v.has_token, q, v.expires_at),
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
