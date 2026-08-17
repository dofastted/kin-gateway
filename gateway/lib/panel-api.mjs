/**
 * Simplified Panel API — UI-friendly shapes for shadcn console.
 *
 * Envelope:
 *   { ok: true, data: T, meta?: object }
 *   { ok: false, error: { type, code, message, ... } }
 */

import { listVms, getVm, summarizeVm, getActiveVmId, setActiveVm } from './vm-registry.mjs'
import { probeAccount } from './usage-probe.mjs'
import { fetchOfficialModels } from './models.mjs'
import { makeError, ErrorType, ErrorCode } from './errors.mjs'
import path from 'node:path'

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

export async function buildProbeOne({ cfg, accountQuota, id, hop = true }) {
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
  const homeDir = path.join(cfg.paths.project, 'vms', vm.id, 'cli-home')
  const token = vm.claude?.access_token
  const inflight = accountQuota?.inflight?.get(vm.claude?.account_uuid || vm.id) || 0
  const maxC = vm.policy?.maxConcurrency || 2
  let doHop = hop
  let hopReason = hop ? null : 'auth_status_only'
  if (doHop && inflight >= maxC) {
    doHop = false
    hopReason = 'concurrency_limit'
  }
  const result = await probeAccount({
    homeDir,
    accessToken: token,
    refreshToken: vm.claude?.refresh_token,
    expiresAt: vm.claude?.expires_at,
    hop: doHop,
    hopReason,
  })
  if (result.ok && (result.five_hour || result.seven_day || result.usage)) {
    const accountId = vm.claude?.account_uuid || vm.id
    accountQuota.ensure({
      account_id: accountId,
      vm_id: vm.id,
      email: result.auth?.email || vm.claude?.email,
      max_concurrency: vm.policy?.maxConcurrency,
    })
    const infos = []
    if (result.five_hour) {
      infos.push({
        rateLimitType: 'five_hour',
        status: result.five_hour.status,
        resetsAt: result.five_hour.resets_at,
        overageStatus: result.five_hour.overage_status,
        isUsingOverage: result.five_hour.is_using_overage,
      })
    }
    if (result.seven_day) {
      infos.push({
        rateLimitType: 'seven_day',
        status: result.seven_day.status,
        resetsAt: result.seven_day.resets_at,
        overageStatus: result.seven_day.overage_status,
        isUsingOverage: result.seven_day.is_using_overage,
      })
    }
    if (infos.length) {
      accountQuota.ingestCliRateLimit(accountId, infos, result.usage, { countRequest: !!result.usage })
    }
  }
  return ok({
    vm_id: id,
    account_uuid: vm.claude?.account_uuid || null,
    source: result.source,
    cli: result.auth || null,
    five_hour: result.five_hour || null,
    seven_day: result.seven_day || null,
    extra_usage: result.extra_usage || null,
    hop_skipped: result.hop_skipped || hopReason,
    probed_at: result.probed_at,
    ok: result.ok,
  })
}

export async function buildProbeAll({ cfg, accountQuota, hop = true }) {
  const vms = listVms(cfg.paths.project)
  const items = []
  for (const s of vms) {
    const one = await buildProbeOne({ cfg, accountQuota, id: s.id, hop })
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
  const result = await fetchOfficialModels(null, { force })
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
    cli_version: result.cli_version || null,
    aliases: result.aliases || [],
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

function enrichVm(v, accountQuota, active) {
  const acc = findAccount(accountQuota, v)
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    active: v.id === active,
    email: v.email,
    account_uuid: v.account_uuid,
    has_token: v.has_token,
    max_concurrency: v.max_concurrency,
    claude_code_version: v.claude_code_version,
    utilization_5h: acc ? Number(acc.unified?.['5h']?.utilization || 0) : null,
    utilization_7d: acc ? Number(acc.unified?.['7d']?.utilization || 0) : null,
    inflight: acc?.inflight ?? 0,
    requests: acc?.requests ?? v.stats?.requests ?? 0,
  }
}

function findAccount(accountQuota, vm) {
  const snap = accountQuota.snapshot()
  return (snap.accounts || []).find(
    (a) => a.vm_id === vm.id || a.account_id === vm.account_uuid,
  )
}
