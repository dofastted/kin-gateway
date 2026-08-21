/**
 * KIN Gateway v2.1 — Node control plane.
 * Inference data plane: one long-lived Go slot worker per VM
 * (slot SOCKS5 + OAuth owner + SSE terminal validation).
 * The gateway converts protocols, schedules the account pool with bounded
 * failover, and never talks to Anthropic or spawns a Claude CLI itself.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, reloadActiveVm } from './lib/core/config.mjs'
import {
  extractApiKey, timingSafeEqualStr, redactSecrets, createRateLimiter,
  verifyPanelLogin, createPanelSession, verifyPanelSession, extractPanelToken, panelSessionCookie, clearPanelSessionCookie, revokePanelSession,
  getPanelAdmin,
} from './lib/core/security.mjs'
import { applyIntercept } from './lib/core/intercept.mjs'
import {
  toClaudeMessages,
  fromClaudeToOpenAIChat,
  fromClaudeToOpenAICompletions,
  fromClaudeToResponses,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createOpenAICompletionStreamState,
  claudeSSELineToOpenAICompletionChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
} from './lib/protocol/convert.mjs'
import { sanitizeInboundBody, defaultSeedPolicy } from './lib/protocol/seed-policy.mjs'
import { sessionKeyToOAuth } from '../scripts/session-to-oauth.mjs'
import { persistOauthToVm, applyOauthToCfg, mirrorWorkerCredentialsToVm } from './lib/oauth/oauth-credentials.mjs'
import crypto from 'node:crypto'
import { fingerprintRequest } from './lib/protocol/client-fingerprint.mjs'
import { validateOfficialModel, ingestWorkerModels, listOfficialModels, seedModelCatalog, getCatalogIds, gatewayModelCatalog } from './lib/protocol/models.mjs'
import {
  loadModelPolicy, getModelPolicy, saveModelPolicy, resetModelPolicy,
  listPolicyModels, syncWorkerModelsIntoPolicy, filterPublicModelIds,
} from './lib/protocol/model-policy.mjs'
import { runVmTestChat, listTestableModels } from './lib/admin/vm-test-chat.mjs'
import { startConcurrentTest, getConcurrentTest, listConcurrentTests, cancelConcurrentTest, listSavedReports, readSavedReport } from './lib/admin/concurrent-test.mjs'
import { startProbeTest, getProbeTest, listProbeTests, cancelProbeTest, getProbeCatalog } from './lib/admin/probe-test.mjs'
import { StickyRouter } from './lib/pool/sticky-router.mjs'
import { AccountQuota } from './lib/pool/account-quota.mjs'
import { ApiKeyStore, publicKeyView } from './lib/admin/api-keys.mjs'
import { RequestLogStore, summarizeBody } from './lib/admin/request-log.mjs'
import { listVms, getVm, summarizeVm, getActiveVmId, setActiveVm, setVmSchedulable, bindVmProxy } from './lib/vm/vm-registry.mjs'
import {
  makeError, mapUpstreamError, validateRequestBody,
  mapModelError, isClientCancelledResult, ErrorType, ErrorCode,
} from './lib/core/errors.mjs'
import * as panel from './lib/admin/panel-api.mjs'
import { ProxyPool } from './lib/vm/proxy-pool.mjs'
import { resolveImportProxy } from './lib/vm/proxy-resolve.mjs'
import { GATEWAY_CAPABILITIES } from './lib/vm/execution-context.mjs'
import { resolveWorkspaceMode, isOfficialClaudeClient } from './lib/protocol/workspace-mode.mjs'
import { officialMessagesBody } from './lib/protocol/anthropic-messages.mjs'
import { prepareOutboundEnvelope } from './lib/protocol/outbound-attempt.mjs'
import { loadVmIdentity } from './lib/identity/vm-identity.mjs'
import { withVmLock, atomicWriteJson } from './lib/vm/vm-file.mjs'
import { openDatabase, closeDatabase } from './lib/db/database.mjs'
import { runLegacyImport } from './lib/db/legacy-import.mjs'
import { initVmDbSync, removeVmFromDb, stopVmWatch } from './lib/vm/vm-db-sync.mjs'
import { BackupService } from './lib/admin/backup-service.mjs'
import { applyCrsIdentityReplace } from './lib/identity/identity-rewrite.mjs'
import { applyCrsUnofficialPersona, personaModeFromRoutingFile, isOfficialClaudeCodeTraffic } from './lib/identity/crs-persona.mjs'
import { ensureClaudeWebSearch, shouldInjectClaudeWebSearch } from './lib/protocol/web-search.mjs'
import { startVmRuntime, stopVmRuntime, OS_CATALOG, kernelForIndex, timezoneForIndex, normalizeUsTimezone, nextNumericIndex, padVm, STANDARD_LOCALE } from './lib/vm/vm-runtime.mjs'
import {
  streamGoWorker,
  workerHealth,
  ensureWorkerCredential,
  importWorkerCredential,
  workerPaths,
} from './lib/transport/go-worker-client.mjs'
import { PoolScheduler } from './lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from './lib/pool/failover-runner.mjs'
import { AccountRuntimeRepo } from './lib/db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from './lib/db/repos/request-attempts-repo.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  restoreToolNames,
  restoreToolNamesInSSELine,
} from './lib/protocol/anthropic-policy.mjs'


function applyVmConcurrency(id, n, { override = true } = {}) {
  const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
  if (!fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const v = Math.max(0, Math.min(256, Number(n) || 0))
  vm.policy = { ...(vm.policy || {}), maxConcurrency: v, concurrencyOverride: !!override }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  accountQuota.setMaxConcurrencyForVm(id, v)
  const uuid = vm.account_uuid || vm.claude?.account_uuid
  if (uuid) accountQuota.setMaxConcurrency(uuid, v)
  return vm
}

function applyRoutingConcurrency(n) {
  const v = Math.max(0, Math.min(256, Number(n) || 0))
  const skip = []
  for (const vm of listVms(cfg.paths.project)) {
    if (vm.policy?.concurrencyOverride) {
      skip.push(vm.id)
      if (vm.account_uuid) skip.push(vm.account_uuid)
      continue
    }
    applyVmConcurrency(vm.id, v, { override: false })
  }
  accountQuota.applyDefaultConcurrency(v, { skipIds: skip })
  return v
}

const FEATURES = [
  'passthrough', 'stream', 'verified-stream', 'protocol-convert', 'go-slot-worker',
  'account-pool-failover', 'weighted-round-robin', 'tools', 'client-workspace',
]
const LIMITATIONS = {
  client_tools: 'kept in native Messages and executed by the caller',
  images: 'all native Messages image blocks are forwarded by the Go slot worker',
  multi_turn_native: 'full Messages history is preserved for every account attempt',
  claude_session: 'sticky commits only after a terminally verified response',
  kernel: 'one Docker container and one long-lived Go worker per slot; not a KVM guest',
  workspace: 'client only; VM/Claude-CLI inference has been removed',
  forward: 'Go worker uses the slot-bound SOCKS5 with no direct or CLI fallback',
  oauth: 'the Go slot worker is the sole refresh owner and uses the same slot SOCKS5',
  realtime_stream: 'account failover stops after the first downstream business event; verified mode buffers to message_stop',
}

const cfg = loadConfig()
if (!getPanelAdmin().password) {
  throw new Error('KIN_ADMIN_PASSWORD must be set; insecure default panel credentials are disabled')
}
fs.mkdirSync(cfg.paths.captures, { recursive: true })

const allowRate = createRateLimiter({
  capacity: cfg.limits.rate_capacity,
  refillPerSec: cfg.limits.rate_refill,
})


// --- Persistent store (SQLite, sub2api-inspired) ---
const dataDir = cfg.paths.data || path.join(cfg.paths.root, 'data')
openDatabase({ dataDir })
try { loadModelPolicy() } catch (e) { console.warn("[model-policy] boot load failed", e?.message || e) }
// one-time migration of legacy JSON files (data/*.json + request-logs) into the DB
const legacyImport = runLegacyImport({ dataDir, projectRoot: cfg.paths.project })
if (legacyImport?.imported) {
  console.log('[db] legacy JSON import done:', JSON.stringify(legacyImport.counts || {}))
}
// VM/credential mirror: write-through hook + startup reconcile + fs.watch
const vmSync = initVmDbSync(cfg.paths.project)
if (vmSync.upserted || vmSync.rebuilt) {
  console.log(`[db] vm mirror reconciled: upserted=${vmSync.upserted} rebuilt=${vmSync.rebuilt}`)
}

// --- P3 sticky + quota ---
const routingConfigPath = path.join(cfg.paths.root, 'config', 'routing.json')
function loadRoutingConfig() {
  try { return JSON.parse(fs.readFileSync(routingConfigPath, 'utf8')) } catch { return {} }
}
let routingConfig = loadRoutingConfig()
const stickyRouter = new StickyRouter({ dataDir, config: routingConfig })
const accountQuota = new AccountQuota({
  dataDir,
  config: routingConfig,
  accounts: listVms(cfg.paths.project).map((v) => ({
    account_id: v.account_uuid || v.id,
    vm_id: v.id,
    email: v.email,
    max_concurrency: v.max_concurrency || 2,
  })),
})

const apiKeyStore = new ApiKeyStore({ dataDir: cfg.paths.data })
const requestLog = new RequestLogStore({
  dataDir: cfg.paths.data,
  mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig?.logging?.mode || 'normal',
})
if (routingConfig?.logging) {
  requestLog.setConfig({
    // Env wins at boot so e2e / ops can force off|debug. Panel PUT still hot-updates.
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging.mode,
    retainDays: routingConfig.logging.retain_days,
  })
}
try { requestLog.cleanup() } catch {}

const disconnectingVms = new Set()
const proxyPool = new ProxyPool({
  dataDir,
  onDisableVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
    // unbind is optional — keep binding for audit but mark VM not schedulable
  },
  onDisconnectVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
    if (process.env.KIN_CRS_MOCK === '1') return
    if (disconnectingVms.has(vmId)) return
    disconnectingVms.add(vmId)
    try {
      const vm = getVm(cfg.paths.project, vmId)
      if (!vm || (vm.status !== 'running' && vm.status !== 'paused')) return
      startVmRuntime(vm, cfg.paths.project, { recreate: true })
    } catch {
      /* tear-down is best-effort; slot stays unschedulable */
    } finally {
      setTimeout(() => disconnectingVms.delete(vmId), 5000)
    }
  },
})
proxyPool.startScheduler()

let runtimeRepo
let attemptsRepo
let poolScheduler
let failoverRunner
function poolSchedulerConfig() {
  return {
    ...(routingConfig.pool || {}),
    fable_max_per_account: Number(routingConfig.concurrency?.fable_max_per_account ?? 4),
    default_max_per_account: Number(routingConfig.concurrency?.default_max_per_account ?? 20),
  }
}

function rebindOauthAccount(vm) {
  const uuid = vm?.claude?.account_uuid
  if (!uuid || !vm?.id) return
  accountQuota.rebindToVm(uuid, vm.id, { email: vm.claude?.email || null })
}
function initPoolRuntime() {
  runtimeRepo = new AccountRuntimeRepo()
  attemptsRepo = new RequestAttemptsRepo()
  accountQuota.attachRuntimeRepo(runtimeRepo)
  try { attemptsRepo.cleanup(routingConfig?.logging?.retain_days || 7) } catch {}
  poolScheduler = new PoolScheduler({
    projectRoot: cfg.paths.project,
    stickyRouter,
    accountQuota,
    runtimeRepo,
    workerHealth,
    config: poolSchedulerConfig(),
  })
  failoverRunner = new FailoverRunner({
    scheduler: poolScheduler,
    stickyRouter,
    attemptsRepo,
    config: routingConfig.failover || {},
    onProxyFailure: (vmId, reason) => {
      proxyPool.reportRuntimeFailure(vmId, reason)
    },
    onCredentialFailure: ({ selected }) => {
      if (!selected?.vm?.claude?.refresh_token && selected?.vmId) {
        setVmSchedulable(cfg.paths.project, selected.vmId, false, 'oauth_no_refresh')
      }
    },
  })
}
initPoolRuntime()

// --- Local backup service (auto schedule default ON; no S3 by design) ---
const backupService = new BackupService({
  dataDir,
  projectRoot: cfg.paths.project,
  configDir: path.join(cfg.paths.root, 'config'),
})
backupService.onRestored((db) => {
  // re-bind every store to the freshly restored connection
  for (const store of [apiKeyStore, accountQuota, stickyRouter, proxyPool, requestLog]) {
    try { store.rebind(db) } catch {}
  }
  try { initPoolRuntime() } catch {}
  try { reloadActiveVm(cfg) } catch {}
})
backupService.startScheduler()


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
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-request-id, x-kin-debug, x-kin-log, x-kin-vm',
    'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE,PATCH',
    'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
  }
  if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
  res.writeHead(status, headers)
  res.end(data)
}

function writeSSEHeaders(res) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
  }
  if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
  res.writeHead(200, headers)
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
  // Master env API key — unlimited admin
  if (timingSafeEqualStr(token, cfg.api_key)) {
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
    req.apiKeyKind = 'master'
    return true
  }

  // Managed multi-keys (sub2api-style)
  const managed = apiKeyStore.authenticate(token)
  if (!managed.ok) {
    const e = makeError({
      type: ErrorType.AUTH,
      code: ErrorCode.INVALID_API_KEY,
      message: 'Invalid credentials',
      status: 401,
    })
    json(res, e.status, e.body)
    return false
  }
  const gate = apiKeyStore.canAccept(managed.record)
  if (!gate.ok) {
    const type = gate.status === 429
      ? (gate.code.includes('quota') ? ErrorType.QUOTA : ErrorType.RATE_LIMIT)
      : ErrorType.PERMISSION
    const e = makeError({
      type,
      code: gate.code,
      message: gate.message,
      status: gate.status,
      details: gate.detail || undefined,
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
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = managed.record
  return true
}

function capture(entry, logBag = null) {
  const safe = JSON.parse(redactSecrets(entry))
  fs.writeFileSync(
    path.join(cfg.paths.captures, `v2-${Date.now()}-${entry.protocol || 'x'}.json`),
    JSON.stringify(safe, null, 2),
  )
  if (logBag) {
    if (entry.hop_meta) logBag.hop_meta = entry.hop_meta
    if (entry.upstream_status != null) logBag.upstream_status = entry.upstream_status
    if (entry.workspace) logBag.workspace = entry.workspace
    if (entry.via) logBag.via = entry.via
    if (entry.usage) logBag.usage = entry.usage
  }
}

// Per-request diff artifacts are debug-only. Sample them so the captures dir
// does not grow without bound (T13). KIN_DIFF_CAPTURE: 0/off, 1/all, or a 0..1 rate.
const DIFF_CAPTURE_RATE = (() => {
  const v = String(process.env.KIN_DIFF_CAPTURE ?? '').trim().toLowerCase()
  if (v === '' ) return 0.05
  if (v === '0' || v === 'off' || v === 'false') return 0
  if (v === '1' || v === 'on' || v === 'true' || v === 'all') return 1
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.05
})()

function diffCapture(dir, name, obj) {
  if (DIFF_CAPTURE_RATE <= 0) return
  if (DIFF_CAPTURE_RATE < 1 && Math.random() > DIFF_CAPTURE_RATE) return
  try {
    fs.writeFileSync(path.join(dir, `${Date.now()}-${name}.json`), JSON.stringify(obj, null, 2))
  } catch {}
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

async function streamAndAssembleClaudeMessage({
  candidate,
  body,
  reqHeaders,
  timeoutMs,
  signal,
  deliveryMode,
  toolNames = {},
  onCommit,
}) {
  const assembler = createClaudeMessageAssembler()
  const workerResult = await streamGoWorker({
    exec: candidate.exec,
    body,
    reqHeaders,
    timeoutMs,
    identity: loadVmIdentity(candidate.exec),
    signal,
    deliveryMode,
    onCommit,
    onEvent: async (line) => {
      applyClaudeSSELineToMessage(restoreToolNamesInSSELine(line, toolNames), assembler)
    },
  })
  if (assembler.message) {
    workerResult.body = assembler.message
    if (assembler.message.usage) workerResult.usage = assembler.message.usage
    if (assembler.message.model) workerResult.model = assembler.message.model
    if (assembler.message.stop_reason) workerResult.stopReason = assembler.message.stop_reason
  }
  if (workerResult?.body) {
    workerResult.body = restoreToolNames(workerResult.body, toolNames)
  }
  return workerResult
}

async function handleProtocol(req, res, protocol, pathName) {
  if (!requireAuth(req, res)) return

  const logCtx = requestLog.start(req, { protocol, pathName })
  res._kinRequestId = logCtx.request_id
  const logBag = {
    protocol,
    model: null,
    stream: false,
    inbound_body: null,
    inbound_summary: null,
    hop_meta: null,
    upstream_status: null,
    outbound_body: null,
    outbound_summary: null,
    vm_id: null,
    account_id: null,
    workspace: 'client',
    has_tools: null,
    usage: null,
    error_code: null,
    error_message: null,
    via: 'go-worker-pool',
    attempt_count: null,
    final_state: null,
    final_account_id: null,
    requested_model: null,
    upstream_model: null,
    first_token_ms: null,
    stop_reason: null,
  }
  res.on('finish', () => {
    try {
      requestLog.finish(logCtx, {
        status: res.statusCode || 0,
        api_key_kind: req.apiKeyKind || null,
        api_key_id: req.apiKeyRecord?.id || null,
        ...logBag,
      })
    } catch {}
  })

  let inbound
  try {
    inbound = await readBody(req, cfg.limits.max_body_bytes)
  } catch (error) {
    stats.errors++
    logBag.error_code = error?.body?.error?.code || ErrorCode.INVALID_JSON
    logBag.error_message = error?.body?.error?.message || String(error?.message || error)
    if (error?.body?.error) return json(res, error.status || 400, error.body)
    return json(res, 400, makeError({
      type: ErrorType.INVALID_REQUEST,
      code: ErrorCode.INVALID_JSON,
      message: String(error?.message || error),
      status: 400,
    }).body)
  }
  logBag.inbound_body = inbound
  logBag.inbound_summary = summarizeBody(inbound)
  logBag.model = inbound?.model || null
  logBag.requested_model = inbound?.model || null
  logBag.stream = !!inbound.stream
  logBag.has_tools = Array.isArray(inbound?.tools) && inbound.tools.length > 0

  const fp = fingerprintRequest(req, inbound)
  const workspace = resolveWorkspaceMode(req, inbound, fp.client_class)
  if (workspace !== 'client') {
    stats.errors++
    logBag.error_code = 'vm_workspace_removed'
    logBag.error_message = 'VM workspace inference was removed; use client workspace'
    return json(res, 400, makeError({
      type: ErrorType.INVALID_REQUEST,
      code: 'vm_workspace_removed',
      message: 'x-kin-workspace: vm is no longer supported. Go slot workers only relay Messages; tools execute on the client.',
      status: 400,
    }).body)
  }

  let ctx = {
    path: pathName,
    protocol,
    body: sanitizeInboundBody(inbound, defaultSeedPolicy()),
    headers: { ...req.headers },
  }
  ctx = applyIntercept(cfg.intercept.rules, 'before_convert', ctx)
  const bodyCheck = validateRequestBody(protocol, ctx.body)
  if (!bodyCheck.ok) {
    stats.errors++
    const errorResult = bodyCheck.errorResult
    logBag.error_code = errorResult.body?.error?.code || 'invalid_request'
    logBag.error_message = errorResult.body?.error?.message || null
    return json(res, errorResult.status, errorResult.body)
  }
  const modelCheck = validateOfficialModel(ctx.body?.model)
  if (!modelCheck.ok) {
    stats.errors++
    const errorResult = mapModelError(modelCheck)
    logBag.error_code = errorResult.body?.error?.code || 'model_not_supported'
    logBag.error_message = errorResult.body?.error?.message || null
    return json(res, errorResult.status, errorResult.body)
  }
  ctx.body = { ...ctx.body, model: modelCheck.model }

  const hdrRewrite = String(req.headers['x-kin-rewrite'] || '') === '1'
  const rewriteEnabled = cfg.rewrite.enabled || hdrRewrite
  const converted = toClaudeMessages(protocol, ctx.body, {
    rewrite: rewriteEnabled,
    model_map: false,
    strict_passthrough: String(req.headers['x-kin-strict-passthrough'] || '') === '1',
  })
  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
  if (converted.mode === 'passthrough') stats.passthrough++
  else if (converted.mode === 'rewrite') stats.rewrite++
  else stats.convert++

  ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', { ...ctx, body: converted.claude })
  const officialClient = isOfficialClaudeClient(fp.client_class)
  const officialTraffic = isOfficialClaudeCodeTraffic(req.headers, inbound)
  ctx.body = applyCrsUnofficialPersona(ctx.body, {
    officialClient: officialTraffic,
    mode: personaModeFromRoutingFile(routingConfigPath),
  })
  if (!officialClient) {
    ctx.body = ensureClaudeWebSearch(ctx.body, {
      enabled: shouldInjectClaudeWebSearch({ clientClass: fp.client_class, headers: req.headers }),
    })
  }
  const canonicalBody = officialMessagesBody(ctx.body)
  const stickyKey = stickyRouter.extractKey(req, inbound)
  const managedKey = req.apiKeyRecord || null
  if (managedKey) {
    const gate = apiKeyStore.acquire(managedKey)
    if (!gate.ok) {
      stats.errors++
      return json(res, gate.status, makeError({
        type: gate.status === 429 ? ErrorType.RATE_LIMIT : ErrorType.PERMISSION,
        code: gate.code,
        message: gate.message,
        status: gate.status,
        details: gate.detail || undefined,
      }).body)
    }
  }

  const abortController = new AbortController()
  const onAborted = () => {
    if (!abortController.signal.aborted) abortController.abort(new Error('client_aborted'))
  }
  req.once('aborted', onAborted)

  const clientStream = !!inbound.stream
  const upstreamStream = true
  const requestedDelivery = String(req.headers['x-kin-delivery'] || routingConfig?.failover?.delivery_mode || 'realtime')
  const deliveryMode = !clientStream
    ? 'verified'
    : (requestedDelivery === 'verified' ? 'verified' : 'realtime')
  let result
  try {
    result = await failoverRunner.run({
      requestId: logCtx.request_id,
      canonicalBody,
      model: canonicalBody.model,
      stickyKey,
      stream: upstreamStream,
      deliveryMode,
      signal: abortController.signal,
      applyAttempt: (body, selected) => {
        const identity = loadVmIdentity(selected.exec)
        const prepared = prepareOutboundEnvelope({
          canonicalBody: body,
          inbound,
          identity,
          unofficial: !officialClient,
          stream: upstreamStream,
          cacheControlLimit: Number(routingConfig?.compatibility?.cache_control_limit) || 4,
          toolNameRewrite: routingConfig?.compatibility?.tool_name_rewrite !== false,
          reqHeaders: req.headers,
          homeDir: selected.exec?.homeDir || '',
        })
        logBag.outbound_body = prepared.body
        logBag.outbound_summary = summarizeBody(prepared.body)
        return { body: prepared.body, meta: { toolNames: prepared.toolNames } }
      },
      callAttempt: async ({ candidate, body, attemptMeta, deliveryMode: attemptDelivery, signal, onCommit }) => {
        if (!clientStream) {
          return streamAndAssembleClaudeMessage({
            candidate,
            body,
            reqHeaders: req.headers,
            timeoutMs: cfg.limits.upstream_timeout_ms,
            signal,
            deliveryMode: attemptDelivery,
            toolNames: attemptMeta?.toolNames || {},
            onCommit,
          })
        }
        let state
        if (protocol === 'openai.chat') {
          state = createOpenAIChatStreamState(inbound.model || body.model, candidate.vmId)
        } else if (protocol === 'openai.completions') {
          state = createOpenAICompletionStreamState(inbound.model || body.model, candidate.vmId)
        } else if (protocol === 'openai.responses') {
          state = createResponsesStreamState(inbound.model || body.model, candidate.vmId)
        }
        return streamGoWorker({
          exec: candidate.exec,
          body,
          reqHeaders: req.headers,
          timeoutMs: cfg.limits.upstream_timeout_ms,
          identity: loadVmIdentity(candidate.exec),
          signal,
          deliveryMode: attemptDelivery,
          onCommit: () => {
            if (protocol === 'anthropic.messages' && !res.headersSent) writeSSEHeaders(res)
            onCommit()
          },
          onEvent: async (line) => {
            line = restoreToolNamesInSSELine(line, attemptMeta?.toolNames || {})
            if (protocol === 'anthropic.messages') {
              if (!res.headersSent) writeSSEHeaders(res)
              res.write(String(line).endsWith('\n') ? String(line) : String(line) + '\n')
              return
            }
            const writeChunks = (chunks) => {
              if (!chunks.length) return
              if (!res.headersSent) writeSSEHeaders(res)
              for (const chunk of chunks) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
            }
            if (protocol === 'openai.chat') {
              writeChunks(claudeSSELineToOpenAIChatChunks(line, state))
              return
            }
            if (protocol === 'openai.completions') {
              writeChunks(claudeSSELineToOpenAICompletionChunks(line, state))
              return
            }
            writeChunks(claudeSSELineToResponsesEvents(line, state))
          },
        })
      },
    })
  } finally {
    req.off('aborted', onAborted)
    if (managedKey) {
      try { apiKeyStore.release(managedKey) } catch {}
    }
  }

  logBag.vm_id = result?.vmId || null
  logBag.account_id = result?.accountId || null
  logBag.final_account_id = result?.accountId || null
  logBag.attempt_count = result?.attemptCount || null
  logBag.final_state = result?.finalState || result?.terminalState || null
  logBag.upstream_status = result?.status ?? null
  logBag.usage = result?.body?.usage || result?.usage || null
  logBag.upstream_model = result?.body?.model || result?.model || null
  logBag.first_token_ms = result?.ttftMs ?? null
  logBag.stop_reason = result?.body?.stop_reason || result?.stopReason || null
  logBag.via = result?.via || 'go-worker-pool'
  if (result?.finalState === 'content_filter' || logBag.stop_reason === 'refusal') {
    logBag.error_code = logBag.error_code || 'content_filter_refusal'
    logBag.error_message = logBag.error_message || 'upstream stop_reason=refusal'
  }

  if (result?.ok && result?.accountId) {
    try { accountQuota.ingestHeaders(result.accountId, result.headers || {}, logBag.usage) } catch {}
    if (managedKey) {
      try { apiKeyStore.recordUsage(managedKey, logBag.usage || {}) } catch {}
    }
  }

  if (clientStream) {
    if (!res.headersSent) {
      const mapped = mapUpstreamError(result?.status || 503, result?.body, result?.headers || {})
      logBag.error_code = mapped.body?.error?.code || 'account_pool_exhausted'
      logBag.error_message = mapped.body?.error?.message || null
      if (!isClientCancelledResult(result) && mapped.body?.error?.code !== 'client_cancelled') stats.errors++
      return json(res, mapped.status, mapped.body)
    }
    if (result?.ok && protocol !== 'anthropic.messages') {
      res.write('data: [DONE]\n\n')
    }
    if (!result?.ok) {
      if (isClientCancelledResult(result)) {
        logBag.error_code = 'client_cancelled'
        logBag.error_message = result?.body?.error?.message || 'Client closed the connection'
      } else {
        stats.errors++
        logBag.error_code = result?.body?.error?.code || 'stream_incomplete'
        logBag.error_message = result?.body?.error?.message || 'Stream did not reach a verified terminal state'
      }
    }
    return res.end()
  }

  if (!result?.ok) {
    const mapped = mapUpstreamError(result?.status || 503, result?.body, result?.headers || {})
    logBag.error_code = mapped.body?.error?.code || 'upstream_error'
    logBag.error_message = mapped.body?.error?.message || null
    if (mapped.body?.error?.code !== 'client_cancelled') stats.errors++
    return json(res, mapped.status, mapped.body)
  }

  let output
  if (protocol === 'anthropic.messages') {
    output = { ...result.body }
    if (String(req.headers['x-kin-debug'] || '') === '1') {
      output.kin = {
        vm_id: result.vmId,
        account_id: result.accountId,
        attempts: result.attemptCount,
        terminal_state: result.finalState,
      }
    }
  } else if (protocol === 'openai.chat') {
    output = fromClaudeToOpenAIChat(result.body, inbound.model, result.vmId, converted.mode)
  } else if (protocol === 'openai.completions') {
    output = fromClaudeToOpenAICompletions(result.body, inbound.model)
  } else {
    output = fromClaudeToResponses(result.body, inbound.model, result.vmId, converted.mode)
  }
  ctx = applyIntercept(cfg.intercept.rules, 'before_client', { ...ctx, body: output })
  return json(res, 200, ctx.body)
}

function activateVmSlot(id) {
  setActiveVm(cfg.paths.project, id)
  reloadActiveVm(cfg)
  const vm = getVm(cfg.paths.project, id)
  accountQuota.ensure({
    account_id: vm?.claude?.account_uuid || id,
    vm_id: id,
    email: vm?.claude?.email || null,
    max_concurrency: vm?.policy?.maxConcurrency || 2,
  })
  return {
    ok: true,
    active_vm: id,
    runtime: GATEWAY_CAPABILITIES.runtime,
    kernel: GATEWAY_CAPABILITIES.kernel,
  }
}

function workerExecForVm(id) {
  const vm = getVm(cfg.paths.project, id)
  if (!vm) return null
  return {
    vmId: id,
    accountId: vm.claude?.account_uuid || id,
    vm,
    homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
  }
}

async function oauthStatusWithWorker(id = null) {
  const vmId = id || getActiveVmId(cfg.paths.project)
  const exec = workerExecForVm(vmId)
  if (!exec) return { ok: false, vm_id: vmId, error: 'vm_not_found' }
  const health = await workerHealth(exec)
  return {
    ok: !!health.ok,
    vm_id: vmId,
    refresh_owner: 'go-slot-worker',
    proxy_required: true,
    worker: health,
    credential: health.credential || null,
  }
}

async function fetchWorkerModels() {
  return gatewayModelCatalog()
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-kin-vm',
        'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
      })
      return res.end()
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const p = url.pathname

    // While a backup restore is swapping the DB, fail protocol traffic fast.
    if (backupService.isRestoring && (p.startsWith('/v1/') || p === '/messages' || p === '/chat/completions' || p === '/responses')) {
      return json(res, 503, makeError({
        type: ErrorType.OVERLOADED,
        code: 'restore_in_progress',
        message: 'Gateway is restoring from backup; retry shortly',
        status: 503,
      }).body)
    }

    if (p === '/admin/routing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, {
        routing: routingConfig,
        sticky: stickyRouter.stats(),
        pool: poolScheduler.snapshot(),
        account_runtime: runtimeRepo.list(),
      })
    }
    if (p === '/admin/routing' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, cfg.limits.max_body_bytes)
      routingConfig = { ...routingConfig, ...body }
      if (body.sticky) routingConfig.sticky = { ...(routingConfig.sticky || {}), ...body.sticky }
      if (body.quota) routingConfig.quota = { ...(routingConfig.quota || {}), ...body.quota }
      if (body.pool) routingConfig.pool = { ...(routingConfig.pool || {}), ...body.pool }
      if (body.failover) routingConfig.failover = { ...(routingConfig.failover || {}), ...body.failover }
      if (body.compatibility) routingConfig.compatibility = { ...(routingConfig.compatibility || {}), ...body.compatibility }
      if (body.concurrency) routingConfig.concurrency = { ...(routingConfig.concurrency || {}), ...body.concurrency }
      fs.mkdirSync(path.dirname(routingConfigPath), { recursive: true })
      fs.writeFileSync(routingConfigPath, JSON.stringify(routingConfig, null, 2))
      stickyRouter.reloadConfig(routingConfig)
      accountQuota.reloadConfig(routingConfig)
      poolScheduler.reloadConfig(poolSchedulerConfig())
      if (body.pool || body.failover) initPoolRuntime()
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
      return json(res, 200, activateVmSlot(id))
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/probe$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop !== false
      const result = await panel.buildProbeOne({ cfg, accountQuota, id, hop })
      if (result.status) return json(res, result.status, result.body)
      return json(res, 200, { vm_id: id, account_uuid: result.data?.account_uuid, probe: result.data })
    }
    if (req.method === 'POST' && p === '/admin/vms/probe-all') {
      if (!requireAuth(req, res)) return
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop !== false
      const result = await panel.buildProbeAll({ cfg, accountQuota, hop })
      return json(res, 200, result)
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
      const username = body.username || body.user || body.u || ''
      const password = body.password || body.pass || body.p || ''
      if (!verifyPanelLogin(username, password)) {
        return json(res, 401, { ok: false, error: { message: '用户名或密码错误', type: 'auth' } })
      }
      const token = createPanelSession(String(username))
      const secure = (process.env.PUBLIC_SCHEME || 'https') === 'https'
      res.setHeader('Set-Cookie', panelSessionCookie(token, { secure }))
      return json(res, 200, {
        ok: true,
        token,
        user: String(username),
        expires_in: 7 * 24 * 3600,
      })
    }
    if (req.method === 'POST' && p === '/api/panel/logout') {
      const tok = extractPanelToken(req)
      if (tok) revokePanelSession(tok)
      const secure = (process.env.PUBLIC_SCHEME || 'https') === 'https'
      res.setHeader('Set-Cookie', clearPanelSessionCookie({ secure }))
      return json(res, 200, { ok: true })
    }


    // ========== Simplified Panel API (shadcn-ready) ==========
    if (p.startsWith('/api/panel')) {
      if (!requireAuth(req, res)) return
      // Managed client keys may only call protocol endpoints — never panel/admin.
      // Only panel session or master KIN_API_KEY may administer.
      const isPanelAdmin = !!req.panelUser || req.apiKeyKind === 'master'
      if (!isPanelAdmin) {
        return json(res, 403, makeError({
          type: ErrorType.PERMISSION,
          code: 'forbidden',
          message: 'Panel requires admin login or master API key',
          status: 403,
        }).body)
      }
      if (req.method === 'GET' && p === '/api/panel/me') {
        return json(res, 200, { ok: true, user: req.panelUser || 'master' })
      }
      if (req.method === 'GET' && p === '/api/panel/api-keys') {
        return json(res, 200, { ok: true, ...apiKeyStore.snapshot() })
      }
      if (req.method === 'POST' && p === '/api/panel/api-keys') {
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const defaultConc = Number(routingConfig?.concurrency?.default_key_concurrency
            ?? routingConfig?.concurrency?.default_max_per_account ?? 20)
          const rec = apiKeyStore.create({
            name: body?.name,
            key: body?.key || body?.custom_key || undefined,
            max_concurrency: body?.max_concurrency ?? defaultConc,
            default_concurrency: defaultConc,
            quota_requests: body?.quota_requests ?? body?.quota,
            rpm: body?.rpm ?? body?.rate_limit_rpm,
            expires_at: body?.expires_at || (body?.expires_in_days
              ? new Date(Date.now() + Number(body.expires_in_days) * 86400_000).toISOString()
              : null),
          })
          return json(res, 201, {
            ok: true,
            item: publicKeyView(rec, { reveal: true }),
            note: 'key is shown only once; store it securely',
          })
        } catch (e) {
          const status = e.code === 'key_exists' ? 409 : 400
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'create_failed' },
          })
        }
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/api-keys\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const rec = apiKeyStore.update(id, body || {})
          if (!rec) {
            return json(res, 404, { ok: false, error: { message: 'api key not found' } })
          }
          return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
        } catch (e) {
          return json(res, 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
        }
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/reset-quota$/.test(p)) {
        const id = p.split('/')[4]
        const rec = apiKeyStore.update(id, { reset_quota: true })
        if (!rec) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/api-keys\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const ok = apiKeyStore.remove(id)
        if (!ok) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        return json(res, 200, { ok: true, deleted: id })
      }

      // ---- Request logs (normal summary + debug full; DB-backed filters/pagination) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs') {
        const u = new URL(req.url, 'http://x')
        const mode = (u.searchParams.get('mode') || 'normal').toLowerCase()
        const limit = Number(u.searchParams.get('limit') || 50)
        if (mode === 'debug') {
          return json(res, 200, {
            ok: true,
            mode: 'debug',
            config: requestLog.snapshot(),
            items: requestLog.listDebug({ limit }),
          })
        }
        const filters = {
          limit,
          offset: Number(u.searchParams.get('offset') || 0),
          api_key_id: u.searchParams.get('api_key_id') || null,
          vm_id: u.searchParams.get('vm_id') || null,
          account_id: u.searchParams.get('account_id') || null,
          model: u.searchParams.get('model') || null,
          protocol: u.searchParams.get('protocol') || null,
          status: u.searchParams.get('status') || null,
          error_class: u.searchParams.get('error_class') || null,
          since: u.searchParams.get('since') || null,
          until: u.searchParams.get('until') || null,
          q: u.searchParams.get('q') || null,
        }
        const { items, total } = requestLog.queryNormal(filters)
        return json(res, 200, {
          ok: true,
          mode: 'normal',
          config: requestLog.snapshot(),
          items,
          total,
          limit: filters.limit,
          offset: filters.offset,
        })
      }
      // ---- Aggregated usage stats from request_logs (charts) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs/stats') {
        const u = new URL(req.url, 'http://x')
        const bucket = (u.searchParams.get('bucket') || 'day').toLowerCase() === 'hour' ? 'hour' : 'day'
        const since = u.searchParams.get('since')
          || new Date(Date.now() - 7 * 86400_000).toISOString()
        const until = u.searchParams.get('until') || null
        return json(res, 200, {
          ok: true,
          bucket,
          since,
          until,
          totals: requestLog.totals(),
          buckets: requestLog.aggregate({ since, until, bucket }),
          window: requestLog.windowStats({ since, until }),
        })
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(p)) {
        const requestId = p.split('/')[4]
        return json(res, 200, panel.ok({
          request_id: requestId,
          attempts: attemptsRepo.list(requestId),
        }))
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const rec = requestLog.getDebug(id)
        if (!rec) return json(res, 404, { ok: false, error: { message: 'debug log not found' } })
        return json(res, 200, { ok: true, item: rec })
      }

      // ---- Backups (local auto/manual, download, restore) ----
      if (req.method === 'GET' && p === '/api/panel/backups') {
        return json(res, 200, {
          ok: true,
          items: backupService.list(),
          config: backupService.getSchedule(),
          next_auto_at: backupService.nextAutoAt(),
          restoring: backupService.isRestoring,
        })
      }
      if (req.method === 'POST' && p === '/api/panel/backups') {
        try {
          const rec = backupService.createBackup({ kind: 'manual' })
          return json(res, 201, { ok: true, item: rec })
        } catch (e) {
          const status = e.code === 'backup_in_progress' ? 409 : 500
          return json(res, status, { ok: false, error: { message: String(e.message || e), code: e.code || 'backup_failed' } })
        }
      }
      if (req.method === 'GET' && p === '/api/panel/backups/config') {
        return json(res, 200, { ok: true, config: backupService.getSchedule(), next_auto_at: backupService.nextAutoAt() })
      }
      if (req.method === 'PUT' && p === '/api/panel/backups/config') {
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const config = backupService.updateSchedule(body || {})
          return json(res, 200, { ok: true, config, next_auto_at: backupService.nextAutoAt() })
        } catch (e) {
          return json(res, 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
        }
      }
      if (req.method === 'GET' && /^\/api\/panel\/backups\/[^/]+\/download$/.test(p)) {
        const id = p.split('/')[4]
        const rec = backupService.get(id)
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
          return json(res, 404, { ok: false, error: { message: 'backup file not found' } })
        }
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': fs.statSync(rec.file_path).size,
          'content-disposition': `attachment; filename="${rec.file_name}"`,
          'x-kin-backup-sha256': rec.sha256 || '',
        })
        fs.createReadStream(rec.file_path).pipe(res)
        return
      }
      if (req.method === 'POST' && /^\/api\/panel\/backups\/[^/]+\/restore$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 4096).catch(() => ({}))
        if (body?.confirm !== true) {
          return json(res, 400, { ok: false, error: { message: 'restore requires {"confirm": true}', code: 'confirm_required' } })
        }
        try {
          const out = backupService.restoreBackup(id)
          return json(res, 200, { ok: true, ...out })
        } catch (e) {
          const map = { backup_not_found: 404, backup_file_missing: 404, restore_in_progress: 409, backup_corrupt: 422, backup_not_ok: 422 }
          return json(res, map[e.code] || 500, { ok: false, error: { message: String(e.message || e), code: e.code || 'restore_failed' } })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/backups\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        if (!backupService.remove(id)) return json(res, 404, { ok: false, error: { message: 'backup not found' } })
        return json(res, 200, { ok: true, deleted: id })
      }


      // GET /api/panel/dashboard
      if (req.method === 'GET' && p === '/api/panel/dashboard') {
        return json(res, 200, panel.buildDashboard({ cfg, accountQuota, stickyRouter, routingConfig, stats, requestLog, poolScheduler, proxyPool }))
      }
      // GET /api/panel/vms
      if (req.method === 'GET' && p === '/api/panel/vms') {
        return json(res, 200, panel.buildVmList({ cfg, accountQuota, routingConfig, poolScheduler, proxyPool }))
      }
      // GET /api/panel/vms/:id
      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const result = panel.buildVmDetail({ cfg, accountQuota, id, routingConfig, poolScheduler, requestLog, proxyPool })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // PATCH /api/panel/vms/:id — hot concurrency (gateway-side, no VM restart)
      if (req.method === 'PATCH' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        const next = body?.max_concurrency ?? body?.maxConcurrency
        if (next == null) {
          return json(res, 400, { ok: false, error: { message: 'max_concurrency required' } })
        }
        const vm = applyVmConcurrency(id, next, { override: true })
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        return json(res, 200, panel.buildVmDetail({ cfg, accountQuota, id, routingConfig, poolScheduler, requestLog, proxyPool }))
      }
      // POST /api/panel/vms/:id/probe
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildProbeOne({ cfg, accountQuota, id })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }

      // POST /api/panel/vms/:id/test-chat — sub2api-style model connectivity test
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/test-chat$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const result = await runVmTestChat({
          projectRoot: cfg.paths.project,
          vmId: id,
          model: body.model || body.model_id || '',
          prompt: body.prompt || body.message || '',
          max_tokens: body.max_tokens,
          timeoutMs: body.timeout_ms || body.timeoutMs,
          requestLog,
        })
        return json(res, 200, panel.ok(result))
      }
      // GET /api/panel/test-models — models available for test dropdown
      if (req.method === 'GET' && p === '/api/panel/test-models') {
        return json(res, 200, panel.ok({ items: listTestableModels() }))
      }


      // Concurrent persistent-conversation load test
      if (req.method === 'POST' && p === '/api/panel/concurrent-test') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const result = startConcurrentTest({
          concurrency: body.concurrency,
          turns: body.turns,
          models: body.models,
          stocks: body.stocks,
          max_tokens: body.max_tokens,
          stream: body.stream,
          timeout_ms: body.timeout_ms,
          baseUrl: `http://127.0.0.1:${cfg.port}`,
          apiKey: cfg.api_key,
          dataDir: cfg.paths?.data || path.join(cfg.paths.project, 'data'),
        })
        if (!result.ok) {
          const status = result.error?.code === 'run_in_progress' ? 409 : 400
          return json(res, status, { ok: false, error: result.error, data: result.data || null })
        }
        return json(res, 200, panel.ok(result.data))
      }
      if (req.method === 'GET' && p === '/api/panel/concurrent-test') {
        const includeText = url.searchParams.get('text') === '1'
        return json(res, 200, panel.ok(getConcurrentTest(null, { includeText })))
      }
      if (req.method === 'GET' && p === '/api/panel/concurrent-tests') {
        return json(res, 200, panel.ok({ items: listConcurrentTests() }))
      }
      if (req.method === 'GET' && p === '/api/panel/concurrent-test-reports') {
        const day = url.searchParams.get('day') || null
        const dataDir = cfg.paths?.data || path.join(cfg.paths.project, 'data')
        return json(res, 200, panel.ok(listSavedReports(dataDir, day)))
      }
      if (req.method === 'GET' && /^\/api\/panel\/concurrent-test-reports\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(p)) {
        const day = p.split('/')[4]
        const name = decodeURIComponent(p.split('/')[5] || '')
        const dataDir = cfg.paths?.data || path.join(cfg.paths.project, 'data')
        const data = readSavedReport(dataDir, day, name)
        if (!data) return json(res, 404, { ok: false, error: { message: 'report not found' } })
        return json(res, 200, panel.ok(data))
      }
      if (req.method === 'POST' && /^\/api\/panel\/concurrent-test\/[^/]+\/cancel$/.test(p)) {
        const id = p.split('/')[4]
        const result = cancelConcurrentTest(id)
        if (!result.ok) return json(res, 404, { ok: false, error: result.error })
        return json(res, 200, panel.ok(result.data))
      }
      if (req.method === 'GET' && /^\/api\/panel\/concurrent-test\/[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        const includeText = url.searchParams.get('text') === '1'
        const data = getConcurrentTest(id, { includeText })
        if (!data) return json(res, 404, { ok: false, error: { message: 'run not found' } })
        return json(res, 200, panel.ok(data))
      }

      if (req.method === 'GET' && p === '/api/panel/probe-test/catalog') {
        return json(res, 200, panel.ok(getProbeCatalog()))
      }
      if (req.method === 'POST' && p === '/api/panel/probe-test') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const result = startProbeTest({
          suite: body.suite,
          models: body.models,
          cases: body.cases,
          forms: body.forms,
          questions: body.questions,
          sample: body.sample ?? body.sample_size,
          random: body.random,
          seed: body.seed,
          max_tokens: body.max_tokens,
          concurrency: body.concurrency,
          timeout_ms: body.timeout_ms,
          baseUrl: `http://127.0.0.1:${cfg.port}`,
          apiKey: cfg.api_key,
          dataDir: cfg.paths?.data || path.join(cfg.paths.project, 'data'),
        })
        if (!result.ok) {
          const status = result.error?.code === 'run_in_progress' ? 409 : 400
          return json(res, status, { ok: false, error: result.error, data: result.data || null })
        }
        return json(res, 200, panel.ok(result.data))
      }
      if (req.method === 'GET' && p === '/api/panel/probe-test') {
        const includeText = url.searchParams.get('text') === '1' || url.searchParams.get('raw') === '1'
        return json(res, 200, panel.ok(getProbeTest(null, { includeText })))
      }
      if (req.method === 'GET' && p === '/api/panel/probe-tests') {
        return json(res, 200, panel.ok({ items: listProbeTests() }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/probe-test\/[^/]+\/cancel$/.test(p)) {
        const id = p.split('/')[4]
        const result = cancelProbeTest(id)
        if (!result.ok) return json(res, 404, { ok: false, error: result.error })
        return json(res, 200, panel.ok(result.data))
      }
      if (req.method === 'GET' && /^\/api\/panel\/probe-test\/[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        const includeText = url.searchParams.get('text') === '1' || url.searchParams.get('raw') === '1'
        const data = getProbeTest(id, { includeText })
        if (!data) return json(res, 404, { ok: false, error: { message: 'run not found' } })
        return json(res, 200, panel.ok(data))
      }

      // POST /api/panel/vms/:id/activate
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/activate$/.test(p)) {
        const id = p.split('/')[4]
        if (!getVm(cfg.paths.project, id)) {
          const e = makeError({ type: ErrorType.NOT_FOUND, code: ErrorCode.VM_NOT_FOUND, message: 'vm not found', status: 404 })
          return json(res, e.status, { ok: false, error: e.body.error })
        }
        return json(res, 200, panel.ok(activateVmSlot(id)))
      }

      // POST /api/panel/vms/:id/update-claude-code — Claude CLI runtime was removed
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/update-claude-code$/.test(p)) {
        return json(res, 410, {
          ok: false,
          error: { code: 'claude_cli_removed', message: 'Claude CLI runtime was replaced by the Go slot worker; build and roll out the worker instead' },
        })
      }

      // DELETE /api/panel/vms/:id — remove VM record, cli-home, unbind proxy
      if (req.method === 'DELETE' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        if (!id || id === 'create' || id === 'import') {
          return json(res, 400, { ok: false, error: { message: 'invalid vm id' } })
        }
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const active = getActiveVmId(cfg.paths.project)
        if (active === id) {
          return json(res, 409, { ok: false, error: { message: 'cannot delete active VM, switch active first' } })
        }
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        // unbind proxy if any
        try {
          const pxId = vm.proxy?.id
          if (pxId) proxyPool.unbind(pxId)
        } catch {}
        // remove cli-home
        try {
          fs.rmSync(path.join(cfg.paths.project, 'vms', id), { recursive: true, force: true })
        } catch {}
        fs.unlinkSync(vmPath)
        // drop the DB credential mirror row too
        try { removeVmFromDb(id) } catch {}
        // optional chat side files
        try {
          const chat = path.join(cfg.paths.project, 'vms', `${id}-chat.json`)
          if (fs.existsSync(chat)) fs.unlinkSync(chat)
        } catch {}
        return json(res, 200, panel.ok({ deleted: id }))
      }
      // POST /api/panel/vms/:id/reset — soft reset: fingerprint + stats + optional oauth clear
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reset$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const body = await readBody(req, 32 * 1024)
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const clearOAuth = body.clear_oauth === true
        const clearStats = body.clear_stats !== false
        const resetFp = body.reset_fingerprint !== false
        const reseeds = body.reseed_cli_home !== false
        if (resetFp) {
          vm.fingerprint = {
            device_id: crypto.randomUUID(),
            session_id: crypto.randomUUID(),
            reset_at: new Date().toISOString(),
          }
        }
        if (clearStats) vm.stats = {}
        if (clearOAuth) {
          vm.claude = {}
          vm.schedulable = false
          vm.status = 'stopped'
          vm.schedule_disabled_reason = 'oauth_cleared'
        }
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        if (reseeds) {
          try {
            const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
            const claudeDir = path.join(homeDir, '.claude')
            fs.mkdirSync(claudeDir, { recursive: true })
            const pol = defaultSeedPolicy(vm.seed_policy || {})
            const env = { ...(pol.extra_env || {}) }
            if (pol.telemetry_disabled) env.DISABLE_TELEMETRY = '1'
            if (pol.disable_nonessential_traffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
            if (pol.do_not_track) env.DO_NOT_TRACK = '1'
            fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env, theme: pol.theme || 'dark' }, null, 2))
            fs.writeFileSync(path.join(claudeDir, 'kin-seed.json'), JSON.stringify({
              pure: true,
              kernel: vm.kernel,
              timezone: vm.timezone,
              locale: vm.locale,
              seed_policy: pol,
              telemetry: pol.telemetry_disabled ? 'disabled' : 'enabled',
              seeded_at: new Date().toISOString(),
            }, null, 2))
            // drop credentials if oauth cleared
            if (clearOAuth) {
              for (const f of ['.credentials.json', 'credentials.json']) {
                try { fs.unlinkSync(path.join(claudeDir, f)) } catch {}
              }
            }
          } catch {}
        }
        return json(res, 200, panel.ok({ vm: summarizeVm(vm) }))
      }

      // POST /api/panel/vms/:id/reset-fingerprint
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reset-fingerprint$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        vm.fingerprint = {
          device_id: crypto.randomUUID(),
          session_id: crypto.randomUUID(),
          reset_at: new Date().toISOString(),
        }
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        return json(res, 200, panel.ok({ id, fingerprint: vm.fingerprint }))
      }




      // GET /api/panel/vms/:id/seed-settings
      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        let settings_json = null
        let kin_seed = null
        try { settings_json = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')) } catch {}
        try { kin_seed = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'kin-seed.json'), 'utf8')) } catch {}
        return json(res, 200, panel.ok({
          vm_id: id,
          seed_policy: defaultSeedPolicy(vm.seed_policy || {}),
          settings_json,
          kin_seed,
          cli_home: homeDir,
        }))
      }
      // PUT /api/panel/vms/:id/seed-settings
      if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const body = await readBody(req, 256 * 1024)
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const merged = { ...(vm.seed_policy || {}), ...(body.seed_policy || {}) }
        for (const k of ['telemetry_disabled','disable_nonessential_traffic','do_not_track','reject_client_settings','reject_client_metadata_identity']) {
          if (body[k] !== undefined) merged[k] = !!body[k]
        }
        if (body.theme !== undefined) merged.theme = body.theme
        if (body.extra_env !== undefined) merged.extra_env = body.extra_env
        if (body.settings_json_override !== undefined) merged.settings_json_override = body.settings_json_override
        const next = defaultSeedPolicy(merged)
        if (body.settings_json_override !== undefined) next.settings_json_override = body.settings_json_override
        if (body.extra_env !== undefined) next.extra_env = body.extra_env || {}
        vm.seed_policy = next
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        const claudeDir = path.join(homeDir, '.claude')
        fs.mkdirSync(claudeDir, { recursive: true })
        const env = { ...(next.extra_env || {}) }
        if (next.telemetry_disabled) env.DISABLE_TELEMETRY = '1'
        if (next.disable_nonessential_traffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
        if (next.do_not_track) env.DO_NOT_TRACK = '1'
        let settings
        if (next.settings_json_override && typeof next.settings_json_override === 'object') {
          settings = { ...next.settings_json_override, env: { ...(next.settings_json_override.env || {}), ...env } }
        } else {
          settings = { env, theme: next.theme || 'dark' }
        }
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2))
        fs.writeFileSync(path.join(claudeDir, 'kin-seed.json'), JSON.stringify({
          pure: true,
          kernel: vm.kernel,
          timezone: vm.timezone,
          locale: vm.locale,
          seed_policy: next,
          telemetry: next.telemetry_disabled ? 'disabled' : 'enabled',
          seeded_at: new Date().toISOString(),
        }, null, 2))
        return json(res, 200, panel.ok({ vm_id: id, seed_policy: next, settings_json: settings }))
      }

      // POST /api/panel/vms/create — configurable seed VM + pure Claude Code home
      if (req.method === 'POST' && p === '/api/panel/vms/create') {
        const body = await readBody(req, 32 * 1024)
        const existing = listVms(cfg.paths.project)
        const idx = nextNumericIndex(existing)
        const rawId = body.id || ('vm-' + padVm(idx))
        const id = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '')
        if (!id) return json(res, 400, { ok: false, error: { message: 'invalid id' } })
        const vmsDir = path.join(cfg.paths.project, 'vms')
        fs.mkdirSync(vmsDir, { recursive: true })
        const vmPath = path.join(vmsDir, id + '.json')
        if (fs.existsSync(vmPath)) {
          return json(res, 409, { ok: false, error: { message: 'vm id exists' } })
        }
        const startNow = body.start !== false && body.status !== 'stopped'
        const wantKernel = body.kernel && OS_CATALOG[body.kernel] ? body.kernel : kernelForIndex(idx)
        const vm = {
          id,
          name: body.name || padVm(idx),
          status: startNow ? 'running' : (body.status || 'stopped'),
          kernel: wantKernel,
          timezone: normalizeUsTimezone(body.timezone || timezoneForIndex(idx)),
          locale: STANDARD_LOCALE,
          region: body.region || body.zone || null,
          note: body.note || `${(OS_CATALOG[wantKernel] || {}).pretty || wantKernel} · Go slot worker`,
          proxy: null,
          policy: {
            maxConcurrency: (() => {
              const raw = Number(body.max_concurrency ?? body.maxConcurrency ?? routingConfig?.concurrency?.default_max_per_account)
              return Number.isFinite(raw) ? Math.max(0, Math.min(128, raw)) : 20
            })(),
            weight: Math.max(1, Math.min(100, Number(body.weight ?? 1))),
            inflight: 0,
          },
          claude: {},
          fingerprint: { device_id: crypto.randomUUID(), session_id: crypto.randomUUID() },
          stats: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          schedulable: false,
          schedule_disabled_reason: 'no_credential',
          proxy_cli_enabled: true,
          seed_policy: defaultSeedPolicy(body.seed_policy || {}),
        }
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        try {
          fs.mkdirSync(path.join(vmsDir, id, 'cli-home', '.claude'), { recursive: true, mode: 0o700 })
        } catch (e) {}
        let allocated = null
        if (!vm.proxy?.url) {
          try {
            allocated = proxyPool.allocateForVm(id)
            if (allocated) {
              bindVmProxy(cfg.paths.project, id, proxyPool.getProxyForVm(id))
              vm.proxy = getVm(cfg.paths.project, id)?.proxy || vm.proxy
            }
          } catch (e) {}
        }
        if (!vm.proxy?.url) {
          vm.status = 'stopped'
          vm.schedulable = false
          vm.schedule_disabled_reason = 'slot SOCKS5 proxy is required'
          atomicWriteJson(vmPath, vm, { mode: 0o600 })
          return json(res, 409, { ok: false, error: { code: 'proxy_required', message: 'No healthy SOCKS5 is available for this VM' }, vm: summarizeVm(vm) })
        }
        if (body.activate === true) {
          try { activateVmSlot(id) } catch (e) {}
        }
        if (startNow) {
          const boot = startVmRuntime(vm, cfg.paths.project)
          if (!boot.ok) {
            vm.status = 'error'
            vm.schedulable = false
            vm.schedule_disabled_reason = boot.error || 'runtime start failed'
            vm.updated_at = new Date().toISOString()
            atomicWriteJson(vmPath, vm, { mode: 0o600 })
            return json(res, 500, { ok: false, error: { message: boot.error || 'runtime start failed' }, vm: summarizeVm(vm) })
          }
          vm.status = 'running'
          vm.updated_at = new Date().toISOString()
          atomicWriteJson(vmPath, vm, { mode: 0o600 })
        }
        const saved = getVm(cfg.paths.project, id) || vm
        return json(res, 200, panel.ok({ vm: summarizeVm(saved), allocated_proxy: allocated }))
      }
      // POST /api/panel/vms/:id/start
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/start$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        let vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const bound = proxyPool.ensureBoundToVm(id, vm.proxy?.id || null)
        if (!bound) {
          return json(res, 409, {
            ok: false,
            error: { code: 'proxy_required', message: 'No SOCKS5 is bound or free for this VM' },
          })
        }
        bindVmProxy(cfg.paths.project, id, bound)
        vm = getVm(cfg.paths.project, id) || vm
        const boot = startVmRuntime(vm, cfg.paths.project)
        if (!boot.ok) return json(res, 500, { ok: false, error: { message: boot.error || 'runtime start failed' } })
        vm.status = 'running'
        vm.schedulable = true
        vm.schedule_disabled_reason = null
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        return json(res, 200, panel.ok({
          vm: summarizeVm(vm),
          allocated_proxy: bound,
          runtime: vm.runtime || GATEWAY_CAPABILITIES.runtime,
          kernel: GATEWAY_CAPABILITIES.kernel,
          boot,
        }))
      }
      // POST /api/panel/vms/:id/stop
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/stop$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const halt = stopVmRuntime(vm)
        if (!halt.ok) return json(res, 500, { ok: false, error: { message: halt.error || 'runtime stop failed' } })
        vm.status = 'stopped'
        vm.schedulable = false
        vm.schedule_disabled_reason = 'stopped'
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        return json(res, 200, panel.ok({
          vm: summarizeVm(vm),
          runtime: vm.runtime || GATEWAY_CAPABILITIES.runtime,
          kernel: GATEWAY_CAPABILITIES.kernel,
          halt,
        }))
      }

      // POST /api/panel/vms/import
      // workflow: create VM → allocate proxy → import sessionKey (via SOCKS) → start
      if (req.method === 'POST' && p === '/api/panel/vms/import') {
        const body = await readBody(req, 64 * 1024)
        const sessionKey = body.sessionKey || body.session_key || body.sid || ''
        const accessToken = body.access_token || body.token || ''
        const vmId = body.vm_id || body.id || null
        try {
          if (!vmId) {
            return json(res, 400, { ok: false, error: { message: 'vm_id required (先创建虚拟机)' } })
          }
          const vmPath = path.join(cfg.paths.project, 'vms', `${vmId}.json`)
          if (!fs.existsSync(vmPath)) {
            return json(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
          }
          const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
          existing.id = existing.id || vmId
          const resolved = resolveImportProxy({
            vm: existing,
            proxyPool,
            overrideUrl: body.proxy_url || null,
          })
          const allowProxyBypass = process.env.KIN_CRS_MOCK === '1' && body.require_proxy === false
          if (sessionKey && !resolved.ok && !allowProxyBypass) {
            const message = resolved.reason === 'proxy_unavailable'
              ? '虚拟机 SOCKS5 不可用，请先更换或探测代理再转换凭证'
              : '虚拟机未绑定 SOCKS5，请先分配代理再转换凭证'
            return json(res, 400, { ok: false, error: { message } })
          }
          const proxyUrl = resolved.proxyUrl
          let oauth = null
          if (sessionKey) {
            oauth = await sessionKeyToOAuth(String(sessionKey).trim(), {
              proxyUrl,
              allowDirectFallback: false,
            })
          } else if (accessToken) {
            oauth = {
              access_token: accessToken,
              refresh_token: body.refresh_token || null,
              expires_at: body.expires_at || null,
              email: body.email || null,
              account_uuid: body.account_uuid || null,
              org_uuid: body.org_uuid || null,
            }
          } else {
            return json(res, 400, { ok: false, error: { message: 'sessionKey or access_token required' } })
          }
          const importedCredential = {
            access_token: oauth.access_token || oauth.accessToken,
            refresh_token: oauth.refresh_token || oauth.refreshToken || null,
            expires_at: oauth.expires_at || oauth.expiresAt || (
              oauth.expires_in ? Math.floor(Date.now() / 1000) + Number(oauth.expires_in) : null
            ),
            email: oauth.email || oauth.email_address || oauth.profile?.email || existing.claude?.email || null,
            account_uuid: oauth.account_uuid || oauth.accountUuid || null,
            org_uuid: oauth.org_uuid || oauth.orgUuid || null,
            scopes: Array.isArray(oauth.scopes)
              ? oauth.scopes
              : String(oauth.scope || '').split(/\s+/).filter(Boolean),
          }
          const workerExec = {
            vmId,
            vm: existing,
            homeDir: path.join(cfg.paths.project, 'vms', vmId, 'cli-home'),
          }
          if (process.env.KIN_CRS_MOCK !== '1') {
            const socket = existing.runtime?.worker_socket
            if (!socket || !fs.existsSync(socket)) {
              const boot = startVmRuntime(existing, cfg.paths.project, { recreate: true })
              if (!boot.ok) {
                return json(res, 502, { ok: false, error: { code: 'worker_start_failed', message: boot.error } })
              }
              existing.runtime = boot.runtime
              existing.status = 'running'
              existing.schedulable = true
              existing.schedule_disabled_reason = null
              atomicWriteJson(vmPath, existing, { mode: 0o600 })
              workerExec.vm = existing
            }
          }
          let workerImport = null
          for (let attempt = 0; attempt < 30; attempt++) {
            workerImport = await importWorkerCredential(workerExec, importedCredential)
            if (workerImport.ok) break
            if (process.env.KIN_CRS_MOCK === '1') break
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          if (!workerImport.ok) {
            return json(res, workerImport.status || 502, {
              ok: false,
              error: {
                type: 'worker_error',
                code: 'worker_credential_import_failed',
                message: workerImport.error?.message || 'Go slot worker rejected credential import',
              },
            })
          }
          // Serialize the token read-modify-write against concurrent harvests (T7).
          await withVmLock(vmPath, () => {
            // Single OAuth writer: persistOauthToVm only
            persistOauthToVm(vmPath, {
              ...importedCredential,
              source: oauth.source || 'sessionKey-cookie-auth',
              mode: 'oauth',
            })
            try { rebindOauthAccount({ ...existing, ...JSON.parse(fs.readFileSync(vmPath, 'utf8')), id: vmId }) } catch {}
            // Reload after single-writer persist
            const refreshed = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
            existing.claude = refreshed.claude || existing.claude
            if (body.name) existing.name = body.name
            existing.updated_at = new Date().toISOString()
            if (body.start !== false) {
              existing.status = 'running'
              existing.schedulable = true
              existing.schedule_disabled_reason = null
            }
            // Non-oauth fields only (status/name) — tokens already written by persistOauthToVm
            atomicWriteJson(vmPath, {
              ...refreshed,
              name: existing.name,
              status: existing.status,
              schedulable: existing.schedulable,
              schedule_disabled_reason: existing.schedule_disabled_reason,
              updated_at: existing.updated_at,
              claude: existing.claude,
            })
          })
          rebindOauthAccount(existing)
          if (body.activate !== false) {
            try { activateVmSlot(vmId) } catch {}
            applyOauthToCfg(cfg, {
              expires_at: existing.claude.expires_at,
              email: existing.claude.email,
              account_uuid: existing.claude.account_uuid,
              org_uuid: existing.claude.org_uuid,
              source: existing.claude.source || 'sessionKey-cookie-auth',
              has_access: existing.claude.has_access,
              has_refresh: existing.claude.has_refresh,
            })
          }
          return json(res, 200, panel.ok({
            vm: summarizeVm(existing),
            proxy_used: !!proxyUrl,
            oauth_email: existing.claude.email,
          }))
        } catch (e) {
          const raw = String(e.message || e)
          const cf = /just a moment|cloudflare|doctype html/i.test(raw)
          return json(res, cf ? 502 : 500, {
            ok: false,
            error: {
              code: e.code || (cf ? 'cloudflare_challenge' : 'import_failed'),
              message: raw.slice(0, 300),
            },
          })
        }
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/oauth\/refresh$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        const vm = getVm(cfg.paths.project, id)
        const result = await ensureWorkerCredential({
          vmId: id,
          vm,
          homeDir,
        }, { force: false })
        if (!result.ok && /invalid_grant|refresh_token/i.test(String(result.error?.message || result.error || ''))) {
          setVmSchedulable(cfg.paths.project, id, false, 'oauth_invalid_grant')
        } else if (result.ok) {
          try { mirrorWorkerCredentialsToVm(vmPath, homeDir) } catch {}
        }
        return json(res, result.ok ? 200 : (result.status || 502), panel.ok({
          ...result,
          vm_id: id,
          refresh_owner: 'go-slot-worker',
          proxy_required: true,
          force: false,
        }))
      }
      if (req.method === 'GET' && p === '/api/panel/oauth') {
        return json(res, 200, panel.ok(await oauthStatusWithWorker()))
      }

      // POST /api/panel/probe
      if (req.method === 'POST' && p === '/api/panel/probe') {
        const result = await panel.buildProbeAll({ cfg, accountQuota })
        return json(res, 200, result)
      }
      // GET /api/panel/usage
      if (req.method === 'GET' && p === '/api/panel/usage') {
        return json(res, 200, panel.buildUsage({ accountQuota, cfg, requestLog }))
      }
      // GET /api/panel/models
      if (req.method === 'GET' && p === '/api/panel/models') {
        return json(res, 200, panel.ok(await fetchWorkerModels()))
      }

      // GET /api/panel/model-policy
      if (req.method === 'GET' && p === '/api/panel/model-policy') {
        const pol = getModelPolicy()
        const workerIds = listOfficialModels().map((m) => m.id)
        // listOfficialModels already policy-filtered; also expose raw worker if needed
        return json(res, 200, panel.ok({
          policy: pol,
          models: listPolicyModels(),
          effective: listOfficialModels(),
        }))
      }
      // PUT /api/panel/model-policy
      if (req.method === 'PUT' && p === '/api/panel/model-policy') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const saved = saveModelPolicy(body.policy || body)
        return json(res, 200, panel.ok({
          policy: saved,
          models: listPolicyModels(),
          effective: listOfficialModels(),
        }))
      }
      // POST /api/panel/model-policy/reset
      if (req.method === 'POST' && p === '/api/panel/model-policy/reset') {
        const saved = resetModelPolicy()
        return json(res, 200, panel.ok({
          policy: saved,
          models: listPolicyModels(),
          effective: listOfficialModels(),
        }))
      }
      // POST /api/panel/model-policy/sync-worker
      if (req.method === 'POST' && p === '/api/panel/model-policy/sync-worker') {
        let workerIds = []
        try { workerIds = getCatalogIds() } catch {}
        if (!workerIds.length) {
          try {
            const raw = JSON.parse(fs.readFileSync('/opt/kin-gateway/data/cli-models.json', 'utf8'))
            if (Array.isArray(raw?.ids)) workerIds = raw.ids
          } catch {}
        }
        const saved = syncWorkerModelsIntoPolicy(workerIds)
        return json(res, 200, panel.ok({
          policy: saved,
          models: listPolicyModels(),
          effective: listOfficialModels(),
          synced: workerIds.length,
        }))
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
        if (body.pool) routingConfig.pool = { ...(routingConfig.pool || {}), ...body.pool }
        if (body.failover) routingConfig.failover = { ...(routingConfig.failover || {}), ...body.failover }
        if (body.compatibility) routingConfig.compatibility = { ...(routingConfig.compatibility || {}), ...body.compatibility }
        if (body.logging) {
          routingConfig.logging = { ...(routingConfig.logging || {}), ...body.logging }
          requestLog.setConfig({
            mode: routingConfig.logging.mode,
            retainDays: routingConfig.logging.retain_days,
          })
        }
        fs.mkdirSync(path.dirname(routingConfigPath), { recursive: true })
        fs.writeFileSync(routingConfigPath, JSON.stringify(routingConfig, null, 2))
        stickyRouter.reloadConfig(routingConfig)
        accountQuota.reloadConfig(routingConfig)
        poolScheduler.reloadConfig(poolSchedulerConfig())
        if (body.pool || body.failover) initPoolRuntime()
        let applied = null
        if (body.concurrency && (body.concurrency.default_max_per_account != null || body.concurrency.default_key_concurrency != null)) {
          applied = applyRoutingConcurrency(
            body.concurrency.default_max_per_account ?? body.concurrency.default_key_concurrency,
          )
        }
        return json(res, 200, panel.ok({ ...routingConfig, applied_default_concurrency: applied }))
      }
      // ---- Proxy Pool ----
      if (req.method === 'GET' && p === '/api/panel/proxies') {
        return json(res, 200, panel.ok(proxyPool.snapshot()))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/import') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const text = body.text || body.lines || (Array.isArray(body) ? body.join('\n') : '')
        const result = proxyPool.importLines(text, {
          fields: body.proxies || body.entries || null,
          host: body.host,
          port: body.port,
          username: body.username ?? body.user,
          password: body.password ?? body.pass,
        })
        const bindVmId = String(body.bind_vm_id || body.vm_id || '').trim()
        let bound = null
        let worker = null
        if (bindVmId && result.items?.[0]?.id) {
          const bind = proxyPool.bind(result.items[0].id, bindVmId)
          if (bind.ok) {
            bindVmProxy(cfg.paths.project, bindVmId, proxyPool.getProxyForVm(bindVmId))
            bound = bind.proxy
            const vm = getVm(cfg.paths.project, bindVmId)
            if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
              setVmSchedulable(cfg.paths.project, bindVmId, false, 'proxy_rebind_worker_restart')
              worker = startVmRuntime(getVm(cfg.paths.project, bindVmId), cfg.paths.project, { recreate: true })
              if (worker.ok) setVmSchedulable(cfg.paths.project, bindVmId, true)
            }
          }
        }
        return json(res, 200, panel.ok({ ...result, bound, worker }))
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
        let worker = null
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setVmSchedulable(cfg.paths.project, vmId, false, 'proxy_rebind_worker_restart')
          worker = startVmRuntime(getVm(cfg.paths.project, vmId), cfg.paths.project, { recreate: true })
          if (worker.ok) setVmSchedulable(cfg.paths.project, vmId, true)
        }
        return json(res, 200, panel.ok({ proxy: result.proxy, worker }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/unbind$/.test(p)) {
        const id = p.split('/')[4]
        const boundVmId = proxyPool.snapshot().proxies.find((proxy) => proxy.id === id)?.bound_vm_id || null
        const result = proxyPool.unbind(id)
        if (!result.ok) return json(res, 404, { ok: false, error: { type: 'not_found_error', code: result.error, message: result.error } })
        if (boundVmId) {
          bindVmProxy(cfg.paths.project, boundVmId, null)
          setVmSchedulable(cfg.paths.project, boundVmId, false, 'proxy_required')
        }
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
        let worker = null
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setVmSchedulable(cfg.paths.project, vmId, false, 'proxy_rebind_worker_restart')
          worker = startVmRuntime(getVm(cfg.paths.project, vmId), cfg.paths.project, { recreate: true })
          if (worker.ok) setVmSchedulable(cfg.paths.project, vmId, true)
        }
        return json(res, 200, panel.ok({ proxy: allocated, worker }))
      }

      return json(res, 404, { ok: false, error: { type: 'not_found_error', code: 'not_found', message: 'panel route not found' } })
    }

    if (req.method === 'GET' && (p === '/console' || p === '/console/')) {
      const candidates = [
        path.join(cfg.paths.root, 'public', 'console.html'),
        path.join(cfg.paths.root, 'gateway', 'public', 'console.html'),
        '/var/www/kin-console/index.html',
      ]
      const htmlPath = candidates.find((f) => { try { return fs.existsSync(f) } catch { return false } })
      if (!htmlPath) return json(res, 404, { error: { message: 'console not found' } })
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
        active_vm: getActiveVmId(cfg.paths.project),
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        stats,
      })
    }

    if (req.method === 'GET' && p === '/v1/meta') {
      return json(res, 200, {
        base_url: cfg.base_url,
        rewrite_default: cfg.rewrite.enabled,
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        endpoints: {
          chat_completions: '/v1/chat/completions',
          responses: '/v1/responses',
          messages: '/v1/messages',
          models: '/v1/models',
          intercept_rules: '/admin/intercept/rules',
        },
        vm: { id: cfg.vm.id, email: cfg.vm.email },
      })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!requireAuth(req, res)) return
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }
    // Admin: fetch current models through a healthy Go slot worker.
    if (req.method === 'POST' && p === '/admin/models/refresh') {
      if (!requireAuth(req, res)) return
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      return await handleProtocol(req, res, 'openai.chat', p)
    }
    if (req.method === 'POST' && (p === '/v1/completions' || p === '/completions')) {
      return await handleProtocol(req, res, 'openai.completions', p)
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

    if (req.method === 'GET' && p === '/admin/vm/oauth') {
      if (!requireAuth(req, res)) return
      return json(res, 200, await oauthStatusWithWorker())
    }
    if (req.method === 'POST' && p === '/admin/vm/oauth/refresh') {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, 4096).catch(() => ({}))
      const id = body.vm_id || getActiveVmId(cfg.paths.project)
      const exec = workerExecForVm(id)
      if (!exec) return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      const result = await ensureWorkerCredential(exec, { force: false })
      return json(res, result.ok ? 200 : (result.status || 502), {
        ...result,
        vm_id: id,
        refresh_owner: 'go-slot-worker',
        proxy_required: true,
      })
    }

    // Claude CLI inference/update was removed; workers are built and deployed separately.
    if (req.method === 'GET' && p === '/admin/vm/claude-code/version') {
      if (!requireAuth(req, res)) return
      return json(res, 410, { error: { code: 'claude_cli_removed', message: 'Claude CLI runtime was replaced by the Go slot worker' } })
    }
    if (req.method === 'POST' && p === '/admin/vm/claude-code/update') {
      if (!requireAuth(req, res)) return
      return json(res, 410, { error: { code: 'claude_cli_removed', message: 'Build and roll out the Go slot worker instead' } })
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
  api_key_set: !!cfg.api_key,
  rewrite_default: false,
  vm_id: cfg.vm.id,
  version: '2.1',
  features: FEATURES,
  capabilities: GATEWAY_CAPABILITIES,
  limitations: LIMITATIONS,
  endpoints: {
    health: `${cfg.base_url}/health`,
    chat: `${cfg.base_url}/v1/chat/completions`,
    responses: `${cfg.base_url}/v1/responses`,
    messages: `${cfg.base_url}/v1/messages`,
    intercept_rules: `${cfg.base_url}/admin/intercept/rules`,
  },
}
// Never persist the raw API key. Public snapshot only.
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.public.json'), JSON.stringify(pub, null, 2))

process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

// Graceful shutdown: stop schedulers/watchers, close the DB (WAL checkpoint).
let _shuttingDown = false
function shutdown(signal) {
  if (_shuttingDown) return
  _shuttingDown = true
  console.log(`[shutdown] ${signal} — closing`)
  try { backupService.stopScheduler() } catch {}
  try { proxyPool.stopScheduler() } catch {}
  try { stopVmWatch() } catch {}
  try { server.close(() => {}) } catch {}
  try { closeDatabase() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(cfg.port, cfg.host, () => {
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : cfg.port
  fetchWorkerModels().then((catalog) => {
    console.log(JSON.stringify({
      event: 'go-worker-model-catalog',
      source: catalog.source,
      total: Array.isArray(catalog.data) ? catalog.data.length : 0,
      vm_id: catalog.vm_id || null,
    }))
  }).catch((error) => console.warn('[worker-models] fetch failed', error.message))
  console.log(JSON.stringify({
    event: 'kin-gateway-v2.1-started',
    port: boundPort,
    base_url: cfg.base_url,
    active_vm: getActiveVmId(cfg.paths.project),
    features: pub.features,
    capabilities: GATEWAY_CAPABILITIES,
    rewrite: cfg.rewrite.enabled,
  }))
})
