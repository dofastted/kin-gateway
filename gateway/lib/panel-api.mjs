/**
 * Simplified Panel API — UI-friendly shapes for shadcn console.
 *
 * Envelope:
 *   { ok: true, data: T, meta?: object }
 *   { ok: false, error: { type, code, message, ... } }
 */

import os from 'node:os'
import { listVms, getVm, summarizeVm, getActiveVmId, setActiveVm } from './vm-registry.mjs'
import { probeAccount } from './usage-probe.mjs'
import { fetchOfficialModels } from './models.mjs'
import { makeError, ErrorType, ErrorCode } from './errors.mjs'

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

export function buildDashboard({ cfg, accountQuota, stickyRouter, routingConfig, stats }) {
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
          utilization_5h: Number(acc.unified?.['5h']?.utilization || 0),
          utilization_7d: Number(acc.unified?.['7d']?.utilization || 0),
          reset_5h: acc.unified?.['5h']?.reset || null,
          reset_7d: acc.unified?.['7d']?.reset || null,
          status_5h: acc.unified?.['5h']?.status || null,
          status_7d: acc.unified?.['7d']?.status || null,
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
  const token = vm.claude?.access_token
  if (!token) {
    return fail(
      makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'no_oauth_token',
        message: 'VM has no OAuth access token',
        status: 400,
      }),
    )
  }
  const result = await probeAccount(token)
  if (result.ok && result.data) {
    const accountId = vm.claude?.account_uuid || vm.id
    accountQuota.ensure({
      account_id: accountId,
      vm_id: vm.id,
      email: vm.claude?.email,
      max_concurrency: vm.policy?.maxConcurrency,
    })
    accountQuota.ingestHeaders(accountId, {
      'anthropic-ratelimit-unified-5h-utilization': result.data.five_hour?.utilization,
      'anthropic-ratelimit-unified-5h-reset': result.data.five_hour?.resets_at,
      'anthropic-ratelimit-unified-7d-utilization': result.data.seven_day?.utilization,
      'anthropic-ratelimit-unified-7d-reset': result.data.seven_day?.resets_at,
    })
  }
  return ok({
    vm_id: id,
    account_uuid: vm.claude?.account_uuid || null,
    source: result.source,
    five_hour: result.data?.five_hour || null,
    seven_day: result.data?.seven_day || null,
    extra_usage: result.data?.extra_usage || null,
    probed_at: result.probed_at,
    ok: result.ok,
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
    utilization_5h: Number(a.unified?.['5h']?.utilization || 0),
    utilization_7d: Number(a.unified?.['7d']?.utilization || 0),
    reset_5h: a.unified?.['5h']?.reset || null,
    reset_7d: a.unified?.['7d']?.reset || null,
    status_5h: a.unified?.['5h']?.status || null,
    status_7d: a.unified?.['7d']?.status || null,
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

export async function buildModels({ cfg, force = false }) {
  // Prefer active VM token; fall back to any VM oauth token
  const tokens = []
  if (cfg.vm?.access_token) tokens.push(cfg.vm.access_token)
  try {
    const { listVms, getVm } = await import('./vm-registry.mjs')
    for (const s of listVms(cfg.paths.project) || []) {
      const vm = getVm(cfg.paths.project, s.id)
      const tok = vm?.claude?.access_token
      if (tok && !tokens.includes(tok)) tokens.push(tok)
    }
  } catch {}
  const result = await fetchOfficialModels(tokens.length ? tokens : null, { force })
  const items = (result.data || []).map((m) => ({
    id: m.id,
    label: m.display_name || m.id,
    max_tokens: m.max_tokens,
    max_input_tokens: m.max_input_tokens,
  }))
  return ok({
    items,
    source: result.source,
    fetched_at: result.fetched_at || null,
    total: items.length,
    upstream_status: result.upstream_status || null,
    note: result.note || result.error || null,
  })
}

export function buildRouting({ routingConfig, stickyRouter }) {
  return ok({
    sticky: routingConfig?.sticky || {},
    quota: routingConfig?.quota || {},
    concurrency: routingConfig?.concurrency || {},
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

function enrichVm(v, accountQuota, active) {
  const acc = findAccount(accountQuota, v)
  const u5 = acc ? Number(acc.unified?.['5h']?.utilization || 0) : null
  const u7 = acc ? Number(acc.unified?.['7d']?.utilization || 0) : null
  const safety = Number(accountQuota?.config?.safety_ratio || 0.95)
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    active: v.id === active,
    kernel: v.kernel || null,
    region: v.region || null,
    timezone: v.timezone || null,
    locale: v.locale || null,
    email: v.email,
    account_uuid: v.account_uuid,
    org_uuid: v.org_uuid || null,
    has_token: v.has_token,
    expires_at: v.expires_at || null,
    proxy: v.proxy || null,
    proxy_id: v.proxy_id || v.proxy?.id || null,
    seed_policy: v.seed_policy || null,
    max_concurrency: v.max_concurrency,
    weight: v.weight ?? 1,
    claude_code_version: v.claude_code_version,
    utilization_5h: u5,
    utilization_7d: u7,
    reset_5h: acc?.unified?.['5h']?.reset || null,
    reset_7d: acc?.unified?.['7d']?.reset || null,
    status_5h: acc?.unified?.['5h']?.status || null,
    status_7d: acc?.unified?.['7d']?.status || null,
    inflight: acc?.inflight ?? 0,
    requests: acc?.requests ?? v.stats?.requests ?? 0,
    tokens_in: acc?.tokens_in ?? 0,
    tokens_out: acc?.tokens_out ?? 0,
    near_limit: u5 != null && (u5 >= safety || (u7 != null && u7 >= safety)),
    fingerprint: v.fingerprint || null,
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
