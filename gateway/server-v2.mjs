/**
 * KIN Gateway v2.1
 * P1: true SSE streaming, tools mapping, intercept rules admin API
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, saveVmPatch } from './lib/config.mjs'
import {
  extractApiKey, timingSafeEqualStr, redactSecrets, createRateLimiter,
  verifyPanelLogin, createPanelSession, verifyPanelSession, extractPanelToken,
  getPanelAdmin,
} from './lib/security.mjs'
import { applyIntercept } from './lib/intercept.mjs'
import {
  toClaudeMessages,
  fromClaudeToOpenAIChat,
  fromClaudeToResponses,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
} from './lib/convert.mjs'
import { callClaudeCli, streamClaudeCli } from './lib/cli-runner.mjs'
import { updateVmClaudeCode, fetchLatestClaudeCodeVersion } from './lib/claude-code-update.mjs'
import { fingerprintRequest, alignToClaudeCodeStandard, officializeToClaudeCli, classifyClient } from './lib/client-fingerprint.mjs'
import { applySystemPromptPolicy, extractSystemAudit } from './lib/system-prompt-policy.mjs'
import { validateOfficialModel, listOfficialModels, fetchOfficialModels } from './lib/models.mjs'
import { StickyRouter } from './lib/sticky-router.mjs'
import { AccountQuota } from './lib/account-quota.mjs'
import { listVms, getVm, summarizeVm, getActiveVmId, setActiveVm, setVmSchedulable, bindVmProxy } from './lib/vm-registry.mjs'
import { probeAccount } from './lib/usage-probe.mjs'
import {
  makeError, mapUpstreamError, validateRequestBody, inspectRequestBody,
  mapQuotaGateError, mapModelError, ErrorType, ErrorCode,
} from './lib/errors.mjs'
import * as panel from './lib/panel-api.mjs'
import { ProxyPool } from './lib/proxy-pool.mjs'

const cfg = loadConfig()
fs.mkdirSync(cfg.paths.captures, { recursive: true })

const allowRate = createRateLimiter({
  capacity: cfg.limits.rate_capacity,
  refillPerSec: cfg.limits.rate_refill,
})


// --- P3 sticky + quota ---
const routingConfigPath = path.join(cfg.paths.root, 'config', 'routing.json')
function loadRoutingConfig() {
  try { return JSON.parse(fs.readFileSync(routingConfigPath, 'utf8')) } catch { return {} }
}
let routingConfig = loadRoutingConfig()
const dataDir = path.join(cfg.paths.root, 'data')
const stickyRouter = new StickyRouter({ dataDir, config: routingConfig })
const accountQuota = new AccountQuota({
  dataDir,
  config: routingConfig,
  accounts: [{
    account_id: cfg.vm.account_uuid || cfg.vm.id,
    vm_id: cfg.vm.id,
    email: cfg.vm.email,
    max_concurrency: cfg.vm.max_concurrency || 2,
  }],
})
const ACTIVE_ACCOUNT = cfg.vm.account_uuid || cfg.vm.id

const proxyPool = new ProxyPool({
  dataDir,
  onDisableVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
    // unbind is optional — keep binding for audit but mark VM not schedulable
  },
})
proxyPool.startScheduler()


const stats = {
  requests: 0,
  passthrough: 0,
  convert: 0,
  rewrite: 0,
  stream: 0,
  errors: 0,
  by_route: {},
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
    'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
  })
  res.end(data)
}

function writeSSEHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
  })
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.BODY_TOO_LARGE,
          message: `Request body exceeds limit of ${maxBytes} bytes`,
          status: 413,
          details: { max_bytes: maxBytes, received: size },
        }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_JSON,
          message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
          status: 400,
          details: { parse_error: String(e.message || e) },
        }))
      }
    })
    req.on('error', (e) => reject(makeError({
      type: ErrorType.API,
      code: 'request_stream_error',
      message: String(e.message || e),
      status: 400,
    })))
  })
}

function requireAuth(req, res) {
  const token = extractPanelToken(req) || extractApiKey(req)
  if (!token) {
    const e = makeError({
      type: ErrorType.AUTH,
      code: ErrorCode.MISSING_API_KEY,
      message: 'Missing credentials. Login at /api/panel/login or provide Authorization Bearer token.',
      status: 401,
    })
    json(res, e.status, e.body)
    return false
  }
  // Panel session
  const session = verifyPanelSession(token)
  if (session) {
    if (!allowRate('panel:' + session.user)) {
      const e = makeError({
        type: ErrorType.RATE_LIMIT,
        code: ErrorCode.GATEWAY_RATE_LIMIT,
        message: 'Gateway rate limit exceeded. Retry later.',
        status: 429,
      })
      json(res, e.status, e.body)
      return false
    }
    req.panelUser = session.user
    return true
  }
  // API key
  if (!timingSafeEqualStr(token, cfg.api_key)) {
    const e = makeError({
      type: ErrorType.AUTH,
      code: ErrorCode.INVALID_API_KEY,
      message: 'Invalid credentials',
      status: 401,
    })
    json(res, e.status, e.body)
    return false
  }
  if (!allowRate(token)) {
    const e = makeError({
      type: ErrorType.RATE_LIMIT,
      code: ErrorCode.GATEWAY_RATE_LIMIT,
      message: 'Gateway rate limit exceeded. Retry later.',
      status: 429,
    })
    json(res, e.status, e.body)
    return false
  }
  return true
}

function capture(entry) {
  const safe = JSON.parse(redactSecrets(entry))
  fs.writeFileSync(
    path.join(cfg.paths.captures, `v2-${Date.now()}-${entry.protocol || 'x'}.json`),
    JSON.stringify(safe, null, 2),
  )
}

function rulesFile() {
  return path.join(cfg.paths.root, 'config', 'intercept-rules.json')
}

function reloadRules() {
  try {
    const data = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'))
    cfg.intercept.rules = Array.isArray(data) ? data : data.rules || []
  } catch {
    cfg.intercept.rules = []
  }
  return cfg.intercept.rules
}

async function handleProtocol(req, res, protocol, pathName) {
  if (!requireAuth(req, res)) return
  let inbound
  try {
    inbound = await readBody(req, cfg.limits.max_body_bytes)
  } catch (err) {
    stats.errors++
    if (err?.body?.error) return json(res, err.status || 400, err.body)
    return json(res, 400, makeError({
      type: ErrorType.INVALID_REQUEST,
      code: ErrorCode.INVALID_JSON,
      message: String(err?.message || err),
      status: 400,
    }).body)
  }
  const wantStream = !!inbound.stream

  // Sticky conversation continuity (bind after validation)
  const stickyKey = stickyRouter.extractKey(req, inbound)
  let bound = stickyKey ? stickyRouter.resolve(stickyKey) : null
  const accountId = bound?.accountId || ACTIVE_ACCOUNT
  const vmId = bound?.vmId || cfg.vm.id

  // --- client fingerprint capture ---
  const fp = fingerprintRequest(req, inbound)
  const diffDir = path.join(cfg.paths.captures, 'client-diff')
  fs.mkdirSync(diffDir, { recursive: true })
  const fpFile = path.join(diffDir, `${Date.now()}-${fp.client_class}.json`)
  fs.writeFileSync(fpFile, JSON.stringify(fp, null, 2))


  const hdrRewrite = String(req.headers['x-kin-rewrite'] || '') === '1'
  const rewriteEnabled = cfg.rewrite.enabled || hdrRewrite

  let ctx = { path: pathName, protocol, body: inbound, headers: { ...req.headers } }
  ctx = applyIntercept(cfg.intercept.rules, 'before_convert', ctx)

  // System prompt policy: DEFAULT OFF — never inject or strip prompts unless explicitly enabled
  // KIN_SYSTEM_POLICY=inspect|strip|strict to enable
  let systemPolicyDecisions = []
  const systemPolicyMode = String(process.env.KIN_SYSTEM_POLICY || 'off').toLowerCase()
  if (
    systemPolicyMode !== 'off' &&
    fp.client_class !== 'claude_code_official' &&
    fp.client_class !== 'claude_official_cli'
  ) {
    const pol = applySystemPromptPolicy(ctx.body, {
      mode: systemPolicyMode,
      source: fp.client_class,
    })
    ctx = { ...ctx, body: pol.body }
    systemPolicyDecisions = pol.decisions
    if (systemPolicyDecisions.length) {
      fs.writeFileSync(
        path.join(diffDir, `${Date.now()}-system-policy.json`),
        JSON.stringify({
          client_class: fp.client_class,
          protocol,
          decisions: systemPolicyDecisions,
          remaining_system: extractSystemAudit(ctx.body),
        }, null, 2),
      )
    }
  }

  const strictPassthrough = String(req.headers['x-kin-strict-passthrough'] || '') === '1'

  // Request body validation
  const bodyCheck = validateRequestBody(protocol, ctx.body)
  if (!bodyCheck.ok) {
    stats.errors++
    const er = bodyCheck.errorResult
    er.body.error.details = {
      ...(er.body.error.details || {}),
      body_inspect: inspectRequestBody(ctx.body),
      protocol,
    }
    return json(res, er.status, er.body)
  }

  // Only official Claude model names — no aliases, reject before upstream
  const modelCheck = validateOfficialModel(ctx.body?.model)
  if (!modelCheck.ok) {
    stats.errors++
    const e = mapModelError(modelCheck)
    e.body.error.details = {
      ...(e.body.error.details || {}),
      body_inspect: inspectRequestBody(ctx.body),
      protocol,
    }
    return json(res, e.status, e.body)
  }
  ctx = { ...ctx, body: { ...ctx.body, model: modelCheck.model } }

  // Quota pre-check + acquire (after validation so failed requests don't hold slots)
  const gate = accountQuota.canAccept(accountId)
  if (!gate.ok) {
    stats.errors++
    const e = mapQuotaGateError(gate)
    return json(res, e.status, e.body)
  }
  accountQuota.acquire(accountId)
  if (stickyKey) stickyRouter.bind(stickyKey, { accountId, vmId })

  const { claude, mode } = toClaudeMessages(protocol, ctx.body, {
    rewrite: rewriteEnabled,
    model_map: false, // aliases disabled
    strict_passthrough: strictPassthrough,
  })

  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
  if (mode === 'passthrough') stats.passthrough++
  else if (mode === 'rewrite') stats.rewrite++
  else stats.convert++

  ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', { ...ctx, body: claude })

  // Body alignment DEFAULT OFF — do not rewrite body or inject metadata/system.
  // Headers-only optional via KIN_ALIGN_HEADERS=1; full body align only KIN_ALIGN_BODY=1
  let upstreamHeadersOverride = null
  const clientClass = fp.client_class
  const alignBody = String(process.env.KIN_ALIGN_BODY || '') === '1'
  const alignHeaders = String(process.env.KIN_ALIGN_HEADERS || '') === '1' || alignBody
  if (
    (alignBody || alignHeaders) &&
    clientClass !== 'claude_code_official' &&
    clientClass !== 'claude_official_cli'
  ) {
    const aligned = alignToClaudeCodeStandard(ctx.body, req.headers)
    if (alignBody) {
      ctx = { ...ctx, body: aligned.body }
    }
    if (alignHeaders) {
      upstreamHeadersOverride = aligned.headers
    }
    fs.writeFileSync(path.join(diffDir, `${Date.now()}-aligned-claude-code-standard.json`), JSON.stringify({
      client_class: clientClass,
      protocol,
      alignment: aligned.alignment,
      align_body: alignBody,
      align_headers: alignHeaders,
      egress_body_keys: Object.keys(ctx.body || {}),
    }, null, 2))
  }

  // -------- streaming path --------
  if (wantStream) {
    stats.stream++
    const releaseStream = () => { try { accountQuota.release(accountId) } catch {} }
    if (protocol === 'anthropic.messages') {
      // Official Anthropic SSE requires both event: and data: (RikkaHub uses event.event)
      writeSSEHeaders(res)
      const result = await streamClaudeCli({ ...buildCliOpts(cfg, ctx.body),
        onHeaders: (h) => accountQuota.ingestHeaders(accountId, h),
        onEvent: async (line) => {
          let evtName = "message"
          const raw = String(line || "")
          const payload = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim()
          try {
            const obj = JSON.parse(payload)
            if (obj && typeof obj.type === "string") evtName = obj.type
          } catch {}
          res.write("event: " + evtName + "\ndata: " + payload + "\n\n")
        },
      })
      if (!result.ok) {
        res.write(`event: error\ndata: ${JSON.stringify(mapUpstreamError(result.status||500, result.body, result.headers||{}).body)}\n\n`)
      }
      releaseStream()
      return res.end()
    }

    if (protocol === 'openai.chat') {
      writeSSEHeaders(res)
      const state = createOpenAIChatStreamState(inbound.model || claude.model, cfg.vm.id)
      const result = await streamClaudeCli({ ...buildCliOpts(cfg, ctx.body),
        onHeaders: (h) => accountQuota.ingestHeaders(accountId, h),
        onEvent: async (line) => {
          const chunks = claudeSSELineToOpenAIChatChunks(line, state)
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
        },
      })
      if (!result.ok) {
        res.write(`data: ${JSON.stringify(mapUpstreamError(result.status||500, result.body, result.headers||{}).body)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      releaseStream()
      return res.end()
    }

    if (protocol === 'openai.responses') {
      writeSSEHeaders(res)
      const state = createResponsesStreamState(inbound.model || claude.model, cfg.vm.id)
      const result = await streamClaudeCli({ ...buildCliOpts(cfg, ctx.body),
        onHeaders: (h) => accountQuota.ingestHeaders(accountId, h),
        onEvent: async (line) => {
          const events = claudeSSELineToResponsesEvents(line, state)
          for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
        },
      })
      if (!result.ok) {
        res.write(`data: ${JSON.stringify(mapUpstreamError(result.status||500, result.body, result.headers||{}).body)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      releaseStream()
      return res.end()
    }
    releaseStream()
  }

  // -------- non-stream --------
  let upstream
  try {
    upstream = await callClaudeCli({ ...buildCliOpts(cfg, ctx.body),
    })
    if (upstream.headers) {
      accountQuota.ingestHeaders(accountId, upstream.headers, upstream.body?.usage)
    }
  } finally {
    accountQuota.release(accountId)
  }

  capture({
    protocol,
    path: pathName,
    mode,
    rewrite_enabled: rewriteEnabled,
    has_tools: Array.isArray(ctx.body.tools) && ctx.body.tools.length > 0,
    upstream_status: upstream.status,
  })

  if (upstream.status !== 200) {
    stats.errors++
    const mapped = mapUpstreamError(upstream.status, upstream.body, upstream.headers || {})
    mapped.body.error.details = {
      ...(mapped.body.error.details || {}),
      protocol,
      mode,
      body_inspect: inspectRequestBody(inbound),
    }
    return json(res, mapped.status, mapped.body)
  }

  let out
  if (protocol === 'anthropic.messages') {
    // Pure Anthropic passthrough — no extra fields (clients break on unknown top-level keys)
    out = { ...upstream.body }
    // debug only when X-Kin-Debug: 1
    if (String(req.headers['x-kin-debug'] || '') === '1') {
      if (req.headers['x-kin-debug'] === '1') out = { ...out, kin: { vm_id: cfg.vm.id, mode } }
    }
  } else if (protocol === 'openai.chat') {
    out = fromClaudeToOpenAIChat(upstream.body, inbound.model, cfg.vm.id, mode)
  } else {
    out = fromClaudeToResponses(upstream.body, inbound.model, cfg.vm.id, mode)
  }

  ctx = applyIntercept(cfg.intercept.rules, 'before_client', { ...ctx, body: out })
  return json(res, 200, ctx.body)
}



function buildCliOpts(cfg, body) {
  const px = resolveVmProxyUrl(cfg)
  return {
    model: body?.model,
    body,
    accessToken: cfg.vm.access_token,
    refreshToken: cfg.vm.refresh_token || null,
    expiresAt: cfg.vm.expires_at || null,
    proxyUrl: px,
    homeDir: `/var/lib/kin/vms/${cfg.vm.id || 'default'}/home`,
    timeoutMs: cfg.limits.upstream_timeout_ms || 180000,
  }
}

function resolveVmProxyUrl(cfg) {
  return null // CLI path: socks ALL_PROXY hangs claude binary; disable until fixed
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
      })
      return res.end()
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const p = url.pathname

    if (p === '/admin/routing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, { routing: routingConfig, sticky: stickyRouter.stats() })
    }
    if (p === '/admin/routing' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, cfg.limits.max_body_bytes)
      routingConfig = { ...routingConfig, ...body }
      if (body.sticky) routingConfig.sticky = { ...(routingConfig.sticky || {}), ...body.sticky }
      if (body.quota) routingConfig.quota = { ...(routingConfig.quota || {}), ...body.quota }
      fs.mkdirSync(path.dirname(routingConfigPath), { recursive: true })
      fs.writeFileSync(routingConfigPath, JSON.stringify(routingConfig, null, 2))
      stickyRouter.reloadConfig(routingConfig)
      accountQuota.reloadConfig(routingConfig)
      return json(res, 200, { ok: true, routing: routingConfig })
    }
    if (p === '/admin/quota' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, accountQuota.snapshot())
    }

    // ---- Multi-VM + usage management ----
    if (req.method === 'GET' && p === '/admin/vms') {
      if (!requireAuth(req, res)) return
      const active = getActiveVmId(cfg.paths.project)
      const vms = listVms(cfg.paths.project).map((v) => ({ ...v, active: v.id === active }))
      return json(res, 200, { vms, active_vm: active, total: vms.length })
    }
    if (req.method === 'GET' && p.startsWith('/admin/vms/') && !p.includes('/probe') && !p.endsWith('/activate')) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, { vm: summarizeVm(vm), active: getActiveVmId(cfg.paths.project) === id })
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/activate$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      if (!getVm(cfg.paths.project, id)) return json(res, 404, { error: { message: 'vm not found' } })
      setActiveVm(cfg.paths.project, id)
      return json(res, 200, { ok: true, active_vm: id })
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/probe$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return json(res, 404, { error: { message: 'vm not found' } })
      const token = vm.claude?.access_token
      if (!token) return json(res, 400, { error: { message: 'no oauth token on vm' } })
      const result = await probeAccount(token)
      if (result.ok && result.data) {
        const accountId = vm.claude?.account_uuid || vm.id
        // map probe into quota store (ratios as 0-1)
        accountQuota.ingestHeaders(accountId, {
          'anthropic-ratelimit-unified-5h-utilization': result.data.five_hour?.utilization,
          'anthropic-ratelimit-unified-5h-reset': result.data.five_hour?.resets_at,
          'anthropic-ratelimit-unified-7d-utilization': result.data.seven_day?.utilization,
          'anthropic-ratelimit-unified-7d-reset': result.data.seven_day?.resets_at,
        })
        const acc = accountQuota.ensure({
          account_id: accountId,
          vm_id: vm.id,
          email: vm.claude?.email,
          max_concurrency: vm.policy?.maxConcurrency,
        })
        acc.last_probe = result
        // persist via snapshot write
        accountQuota.ingestHeaders(accountId, {})
      }
      return json(res, 200, { vm_id: id, account_uuid: vm.claude?.account_uuid, probe: result })
    }
    if (req.method === 'POST' && p === '/admin/vms/probe-all') {
      if (!requireAuth(req, res)) return
      const vms = listVms(cfg.paths.project)
      const results = []
      for (const s of vms) {
        const vm = getVm(cfg.paths.project, s.id)
        const token = vm?.claude?.access_token
        if (!token) {
          results.push({ vm_id: s.id, ok: false, error: 'no token' })
          continue
        }
        const result = await probeAccount(token)
        if (result.ok && result.data) {
          const accountId = vm.claude?.account_uuid || vm.id
          accountQuota.ingestHeaders(accountId, {
            'anthropic-ratelimit-unified-5h-utilization': result.data.five_hour?.utilization,
            'anthropic-ratelimit-unified-5h-reset': result.data.five_hour?.resets_at,
            'anthropic-ratelimit-unified-7d-utilization': result.data.seven_day?.utilization,
            'anthropic-ratelimit-unified-7d-reset': result.data.seven_day?.resets_at,
          })
        }
        results.push({ vm_id: s.id, email: s.email, account_uuid: s.account_uuid, probe: result })
      }
      return json(res, 200, { total: results.length, results })
    }
    if (req.method === 'GET' && p === '/admin/usage/summary') {
      if (!requireAuth(req, res)) return
      const snap = accountQuota.snapshot()
      const vms = listVms(cfg.paths.project)
      const accounts = snap.accounts || []
      const max5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)))
      const max7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)))
      const sumTokensIn = accounts.reduce((s, a) => s + (a.tokens_in || 0), 0)
      const sumTokensOut = accounts.reduce((s, a) => s + (a.tokens_out || 0), 0)
      const sumReq = accounts.reduce((s, a) => s + (a.requests || 0), 0)
      const nearLimit = accounts.filter(
        (a) =>
          Number(a.unified?.['5h']?.utilization || 0) >= snap.safety_ratio ||
          Number(a.unified?.['7d']?.utilization || 0) >= snap.safety_ratio,
      )
      return json(res, 200, {
        safety_ratio: snap.safety_ratio,
        vm_count: vms.length,
        account_count: accounts.length,
        totals: {
          requests: sumReq,
          tokens_in: sumTokensIn,
          tokens_out: sumTokensOut,
          peak_5h_utilization: max5,
          peak_7d_utilization: max7,
          near_limit_count: nearLimit.length,
        },
        accounts,
        vms,
      })
    }

    // ========== Panel login (public) ==========
    if (req.method === 'POST' && p === '/api/panel/login') {
      const body = await readBody(req, 4096)
      const username = body.username || body.user || body.account
      const password = body.password || body.pass
      if (!verifyPanelLogin(username, password)) {
        const e = makeError({
          type: ErrorType.AUTH,
          code: ErrorCode.INVALID_API_KEY,
          message: 'Invalid username or password',
          status: 401,
        })
        return json(res, e.status, e.body)
      }
      const token = createPanelSession(String(username))
      return json(res, 200, {
        ok: true,
        token,
        user: String(username),
        expires_in: 7 * 24 * 3600,
      })
    }

    // ========== Simplified Panel API (shadcn-ready) ==========
    if (p.startsWith('/api/panel')) {
      if (!requireAuth(req, res)) return
      if (req.method === 'GET' && p === '/api/panel/me') {
        return json(res, 200, { ok: true, user: req.panelUser || 'api-key' })
      }
      // GET /api/panel/dashboard
      if (req.method === 'GET' && p === '/api/panel/dashboard') {
        return json(res, 200, panel.buildDashboard({ cfg, accountQuota, stickyRouter, routingConfig, stats }))
      }
      // GET /api/panel/vms
      if (req.method === 'GET' && p === '/api/panel/vms') {
        return json(res, 200, panel.buildVmList({ cfg, accountQuota }))
      }
      // GET /api/panel/vms/:id
      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const result = panel.buildVmDetail({ cfg, accountQuota, id })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // POST /api/panel/vms/:id/probe
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildProbeOne({ cfg, accountQuota, id })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // POST /api/panel/vms/:id/activate
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/activate$/.test(p)) {
        const id = p.split('/')[4]
        if (!getVm(cfg.paths.project, id)) {
          const e = makeError({ type: ErrorType.NOT_FOUND, code: ErrorCode.VM_NOT_FOUND, message: 'vm not found', status: 404 })
          return json(res, e.status, { ok: false, error: e.body.error })
        }
        setActiveVm(cfg.paths.project, id)
        return json(res, 200, panel.ok({ active_vm: id }))
      }
      // POST /api/panel/probe
      if (req.method === 'POST' && p === '/api/panel/probe') {
        const result = await panel.buildProbeAll({ cfg, accountQuota })
        return json(res, 200, result)
      }
      // GET /api/panel/usage
      if (req.method === 'GET' && p === '/api/panel/usage') {
        return json(res, 200, panel.buildUsage({ accountQuota, cfg }))
      }
      // GET /api/panel/models
      if (req.method === 'GET' && p === '/api/panel/models') {
        const force = String(new URL(req.url, 'http://x').searchParams.get('refresh') || '') === '1'
        return json(res, 200, await panel.buildModels({ cfg, force }))
      }
      // GET /api/panel/routing
      if (req.method === 'GET' && p === '/api/panel/routing') {
        return json(res, 200, panel.buildRouting({ routingConfig, stickyRouter }))
      }
      // PUT /api/panel/routing
      if (req.method === 'PUT' && p === '/api/panel/routing') {
        const body = await readBody(req, cfg.limits.max_body_bytes)
        routingConfig = { ...routingConfig, ...body }
        if (body.sticky) routingConfig.sticky = { ...(routingConfig.sticky || {}), ...body.sticky }
        if (body.quota) routingConfig.quota = { ...(routingConfig.quota || {}), ...body.quota }
        if (body.concurrency) routingConfig.concurrency = { ...(routingConfig.concurrency || {}), ...body.concurrency }
        fs.mkdirSync(path.dirname(routingConfigPath), { recursive: true })
        fs.writeFileSync(routingConfigPath, JSON.stringify(routingConfig, null, 2))
        stickyRouter.reloadConfig(routingConfig)
        accountQuota.reloadConfig(routingConfig)
        return json(res, 200, panel.ok(routingConfig))
      }
      // ---- Proxy Pool ----
      if (req.method === 'GET' && p === '/api/panel/proxies') {
        return json(res, 200, panel.ok(proxyPool.snapshot()))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/import') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const text = body.text || body.lines || (Array.isArray(body) ? body.join('\n') : '')
        const result = proxyPool.importLines(text)
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/probe') {
        const result = await proxyPool.probeAll({ onlyEnabled: true })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'GET' && p === '/api/panel/proxies/config') {
        return json(res, 200, panel.ok(proxyPool.snapshot().config))
      }
      if (req.method === 'PUT' && p === '/api/panel/proxies/config') {
        const body = await readBody(req, 64 * 1024)
        const result = proxyPool.updateConfig(body)
        if (!result.ok) return json(res, 400, { ok: false, error: { type: 'invalid_request_error', code: result.error, message: result.error, details: result } })
        return json(res, 200, panel.ok(result.config))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const result = await proxyPool.probeById(id)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/enable$/.test(p)) {
        const id = p.split('/')[4]
        const result = proxyPool.setEnabled(id, true)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        // re-enable bound VM scheduling if any
        if (result.proxy?.bound_vm_id) {
          setVmSchedulable(cfg.paths.project, result.proxy.bound_vm_id, true, null)
        }
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/disable$/.test(p)) {
        const id = p.split('/')[4]
        const result = proxyPool.setEnabled(id, false)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/bind$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        const vmId = body.vm_id
        if (!vmId) return json(res, 400, { ok: false, error: { type: 'invalid_request_error', code: 'missing_field', message: 'vm_id required', param: 'vm_id' } })
        const result = proxyPool.bind(id, vmId)
        if (!result.ok) return json(res, 400, { ok: false, error: { type: 'invalid_request_error', code: result.error, message: result.error, details: result } })
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/unbind$/.test(p)) {
        const id = p.split('/')[4]
        const result = proxyPool.unbind(id)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/proxies\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const result = proxyPool.remove(id)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        return json(res, 200, panel.ok(result.removed))
      }
      // Auto-allocate proxy for a VM
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/allocate-proxy$/.test(p)) {
        const vmId = p.split('/')[4]
        const allocated = proxyPool.allocateForVm(vmId)
        if (!allocated) return json(res, 409, { ok: false, error: { type: 'api_error', code: 'no_free_proxy', message: 'No free SOCKS5 in pool' } })
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        return json(res, 200, panel.ok(allocated))
      }

      return json(res, 404, { ok: false, error: { type: 'not_found_error', code: 'not_found', message: 'panel route not found' } })
    }

    if (req.method === 'GET' && (p === '/console' || p === '/console/')) {
      const htmlPath = path.join(cfg.paths.root, 'public', 'console.html')
      if (!fs.existsSync(htmlPath)) return json(res, 404, { error: { message: 'console not found' } })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(htmlPath))
    }

    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      return json(res, 200, {
        status: 'ok',
        service: 'kin-gateway-v2.1',
        base_url: cfg.base_url,
        rewrite: cfg.rewrite.enabled ? 'on' : 'off',
        intercept_rules: cfg.intercept.rules.length,
        vm_id: cfg.vm.id,
        claude_code_version: cfg.vm.claude_code_version,
        features: ['passthrough', 'stream', 'tools', 'intercept-admin'],
        stats,
      })
    }

    if (req.method === 'GET' && p === '/v1/meta') {
      return json(res, 200, {
        base_url: cfg.base_url,
        rewrite_default: cfg.rewrite.enabled,
        features: ['stream', 'tools', 'passthrough', 'intercept-admin'],
        endpoints: {
          chat_completions: '/v1/chat/completions',
          responses: '/v1/responses',
          messages: '/v1/messages',
          models: '/v1/models',
          intercept_rules: '/admin/intercept/rules',
          claude_code_update: '/admin/vm/claude-code/update',
        },
        vm: { id: cfg.vm.id, email: cfg.vm.email, claude_code_version: cfg.vm.claude_code_version },
      })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!requireAuth(req, res)) return
      const force = String(new URL(req.url, 'http://x').searchParams.get('refresh') || '') === '1'
      const result = await fetchOfficialModels(cfg.vm.access_token, { force })
      return json(res, 200, result)
    }
    // Admin: force refresh models cache
    if (req.method === 'POST' && p === '/admin/models/refresh') {
      if (!requireAuth(req, res)) return
      const result = await fetchOfficialModels(cfg.vm.access_token, { force: true })
      return json(res, 200, result)
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      return await handleProtocol(req, res, 'openai.chat', p)
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      return await handleProtocol(req, res, 'openai.responses', p)
    }
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      return await handleProtocol(req, res, 'anthropic.messages', p)
    }

    // ---- intercept rules admin ----
    if (p === '/admin/intercept/rules') {
      if (!requireAuth(req, res)) return
      if (req.method === 'GET') {
        return json(res, 200, { rules: reloadRules() })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 256 * 1024)
        const rules = Array.isArray(body) ? body : body.rules
        if (!Array.isArray(rules)) {
          return json(res, 400, { error: { message: 'rules must be array' } })
        }
        fs.writeFileSync(rulesFile(), JSON.stringify(rules, null, 2))
        cfg.intercept.rules = rules
        return json(res, 200, { ok: true, count: rules.length, rules })
      }
      if (req.method === 'DELETE') {
        fs.writeFileSync(rulesFile(), '[]')
        cfg.intercept.rules = []
        return json(res, 200, { ok: true, count: 0, rules: [] })
      }
    }

    // ---- Claude Code update ----
    if (req.method === 'GET' && p === '/admin/vm/claude-code/version') {
      if (!requireAuth(req, res)) return
      const latest = await fetchLatestClaudeCodeVersion()
      return json(res, 200, { vm_id: cfg.vm.id, current: cfg.vm.claude_code_version, latest })
    }
    if (req.method === 'POST' && p === '/admin/vm/claude-code/update') {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, 64 * 1024)
      const result = await updateVmClaudeCode(cfg.vm.path, { version: body.version || 'latest' })
      cfg.vm.claude_code_version = result.version
      return json(res, 200, result)
    }

    json(res, 404, { error: { message: `not found: ${p}` } })
  } catch (e) {
    stats.errors++
    const status = e.status || 500
    if (!res.headersSent) {
      json(res, status, { error: { message: e.message || String(e), type: 'server_error' } })
    } else {
      try { res.end() } catch {}
    }
  }
})

const pub = {
  base_url: cfg.base_url,
  api_key: cfg.api_key,
  rewrite_default: false,
  vm_id: cfg.vm.id,
  version: '2.1',
  features: ['passthrough', 'stream', 'tools', 'intercept-admin'],
  endpoints: {
    health: `${cfg.base_url}/health`,
    chat: `${cfg.base_url}/v1/chat/completions`,
    responses: `${cfg.base_url}/v1/responses`,
    messages: `${cfg.base_url}/v1/messages`,
    intercept_rules: `${cfg.base_url}/admin/intercept/rules`,
    cc_update: `${cfg.base_url}/admin/vm/claude-code/update`,
  },
}
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.json'), JSON.stringify(pub, null, 2), { mode: 0o600 })
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.public.json'), JSON.stringify({
  ...pub,
  api_key: cfg.api_key.slice(0, 12) + '…' + cfg.api_key.slice(-6),
}, null, 2))

process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

server.listen(cfg.port, cfg.host, () => {
  console.log(JSON.stringify({
    event: 'kin-gateway-v2.1-started',
    base_url: cfg.base_url,
    api_key: cfg.api_key,
    features: pub.features,
    rewrite: cfg.rewrite.enabled,
  }, null, 2))
})
