/**
 * Per-VM model connectivity test (sub2api-style AccountTest).
 *
 * Pins one credential slot and runs a short Messages call through the same
 * unofficial-client path as production /v1:
 *   persona + identity replace + policy prepare + Go worker.
 *
 * 429 lesson (2026-08-20): do NOT send a reduced anthropic-beta. Unofficial
 * inbound without beta replays stored Claude Code betas (minus context-1m).
 * Overwriting them with a short TEST_BETAS list made Anthropic classify
 * Sonnet/Opus/Fable as OAuth extra-usage → HTTP 429 {type:rate_limit_error,message:"Error"}.
 * Haiku is included even as extra-usage, so it still returned 200.
 * Keep UA unofficial so storeAccountHeaders does not overwrite kin-cc-headers.json.
 */
import { getVm } from '../vm/vm-registry.mjs'
import { vmJsonPath, vmCliHomePath } from '../vm/execution-context.mjs'
import { streamGoWorker } from '../transport/go-worker-client.mjs'
import { loadVmIdentity } from '../identity/vm-identity.mjs'
import { applyCrsIdentityReplace } from '../identity/identity-rewrite.mjs'
import { applyCrsUnofficialPersona } from '../identity/crs-persona.mjs'
import { resolveCrsHeaders } from '../identity/crs-headers.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { prepareAnthropicRequest } from '../protocol/anthropic-policy.mjs'
import { createClaudeMessageAssembler, applyClaudeSSELineToMessage } from '../protocol/convert.mjs'
import {
  isModelEnabled,
  getModelParams,
  getCapabilities,
  listPolicyModels,
  applyMaxTokensCap,
} from '../protocol/model-policy.mjs'
import { listOfficialModels, validateOfficialModel } from '../protocol/models.mjs'

const DEFAULT_PROMPT = 'hello'
const DEFAULT_MAX_TOKENS = 64
const TEST_UA = 'kin-console-test/1.0'

export function listTestableModels() {
  const rank = (id) => {
    const s = String(id || '').toLowerCase()
    if (s.includes('haiku')) return 0
    if (s.includes('sonnet')) return 1
    if (s.includes('opus')) return 2
    return 3
  }
  const map = (m, source) => ({
    id: m.id,
    label: m.label || m.display_name || m.id,
    source,
  })
  const effective = listOfficialModels().map((m) => map(m, 'effective'))
  const list = effective.length
    ? effective
    : listPolicyModels().filter((m) => m.enabled !== false).map((m) => map(m, 'policy'))
  return list.sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)))
}

function buildExec(projectRoot, vm) {
  const accountId = vm.claude?.account_uuid || vm.account_uuid || vm.id
  return {
    vmId: vm.id,
    accountId,
    vm,
    vmPath: vmJsonPath(projectRoot, vm.id),
    homeDir: vmCliHomePath(projectRoot, vm.id),
    oauth: {
      email: vm.claude?.email || null,
      account_uuid: vm.claude?.account_uuid || null,
      org_uuid: vm.claude?.org_uuid || null,
      expires_at: vm.claude?.expires_at || null,
    },
    proxyUrl: vm.proxy?.url || null,
    timezone: vm.timezone || 'UTC',
    locale: vm.locale || 'en_US.UTF-8',
    kernel: vm.kernel || null,
  }
}

function extractText(body) {
  if (!body || typeof body !== 'object') return ''
  const blocks = Array.isArray(body.content) ? body.content : []
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && b.text) parts.push(String(b.text))
    else if (b.type === 'thinking' && b.thinking) parts.push('[thinking] ' + String(b.thinking).slice(0, 200))
  }
  if (parts.length) return parts.join('\n')
  const err = body.error
  if (err && typeof err === 'object') {
    const bits = [err.message, err.type, err.code].filter((x) => x && String(x) !== 'Error')
    if (bits.length) return bits.join(' · ')
    try { return JSON.stringify(err).slice(0, 800) } catch {}
  }
  if (typeof body.message === 'string' && body.message && body.message !== 'Error') return body.message
  try { return JSON.stringify(body).slice(0, 800) } catch { return '' }
}

function extractError(result) {
  const body = result?.body
  const err = body?.error && typeof body.error === 'object' ? body.error : {}
  const headers = result?.headers || {}
  const retry = headers['retry-after'] || headers['anthropic-ratelimit-requests-reset'] || null
  const requestId = headers['request-id'] || headers['x-request-id'] || err.request_id || null
  let message = extractText(body) || 'upstream error'
  if (result?.status === 429 && (message === 'Error' || /rate_limit/i.test(message) || message === 'upstream error')) {
    message = '上游 429 rate_limit（OAuth extra usage / 模型额度）。测试已走非官方回放路径（不覆盖 stored Claude Code beta）。'
  }
  const out = {
    type: err.type || (result?.status === 429 ? 'rate_limit_error' : 'upstream_error'),
    code: err.code || (result?.status === 429 ? 'upstream_rate_limit' : 'upstream_error'),
    message,
  }
  if (retry) out.retry_after = retry
  if (requestId) out.request_id = requestId
  if (result?.status) out.status = result.status
  if (err.message && err.message !== message) out.upstream_message = String(err.message).slice(0, 400)
  return out
}

function prepareTestBody(model, prompt, maxTokens) {
  let body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  }
  const caps = getCapabilities(model) || {}
  if (caps.requires_adaptive || caps.thinking_mode === 'adaptive_only') {
    body.thinking = { type: 'adaptive' }
  }
  body = applyCrsUnofficialPersona(body, { officialClient: false })
  body = applyMaxTokensCap(body)
  return body
}

function beginTestLog(requestLog, vmId) {
  if (!requestLog?.start) return null
  return requestLog.start({
    method: 'POST',
    headers: { 'user-agent': TEST_UA },
    socket: {},
  }, { protocol: 'anthropic.messages', pathName: `/api/panel/vms/${vmId || 'unknown'}/test-chat` })
}

function endTestLog(requestLog, logCtx, extra = {}) {
  if (!requestLog?.finish || !logCtx) return
  try {
    requestLog.finish(logCtx, {
      protocol: 'anthropic.messages',
      workspace: 'client',
      stream: false,
      user_agent: TEST_UA,
      ...extra,
    })
  } catch {}
}

/**
 * @param {{ projectRoot: string, vmId: string, model?: string, prompt?: string, max_tokens?: number, timeoutMs?: number, requestLog?: object }} opts
 */
export async function runVmTestChat(opts = {}) {
  const projectRoot = opts.projectRoot
  const vmId = String(opts.vmId || '').trim()
  const started = Date.now()
  const requestLog = opts.requestLog || null
  const logCtx = beginTestLog(requestLog, vmId)
  const log = []
  const push = (level, message) => {
    log.push({ at: new Date().toISOString(), level, message: String(message) })
  }
  const done = (payload) => {
    endTestLog(requestLog, logCtx, {
      status: payload.status || (payload.ok ? 200 : 0),
      model: payload.model || null,
      requested_model: payload.model || null,
      upstream_model: payload.usage?.model || payload.debug?.upstream_model || payload.model || null,
      vm_id: payload.vm_id || vmId || null,
      account_id: payload.account_uuid || null,
      usage: payload.usage || null,
      stop_reason: payload.stop_reason || null,
      via: payload.via || 'go-worker',
      error_code: payload.ok ? null : (payload.error?.code || 'test_chat_failed'),
      error_message: payload.ok ? null : (payload.error?.message || null),
    })
    return payload
  }

  if (!projectRoot || !vmId) {
    return done({ ok: false, error: { code: 'invalid_request', message: 'vm_id required' }, log, duration_ms: 0 })
  }

  const vm = getVm(projectRoot, vmId)
  if (!vm) {
    return done({ ok: false, error: { code: 'vm_not_found', message: `vm not found: ${vmId}` }, log, duration_ms: 0 })
  }

  push('info', `开始测试凭证槽 ${vm.name || vmId}`)
  push('info', `状态 running=${vm.status === 'running'} schedulable=${vm.schedulable !== false}`)

  const token = vm.claude?.access_token || vm.claude?.refresh_token || vm.claude?.session_key
  if (!token) {
    push('error', '无 OAuth / session 凭证')
    return done({
      ok: false,
      vm_id: vmId,
      error: { code: 'no_credential', message: 'VM has no Claude credential' },
      log,
      duration_ms: Date.now() - started,
    })
  }

  if (!vm.proxy?.url && !vm.proxy?.host) {
    push('warn', '未绑定 SOCKS5，可能 fail-closed')
  } else {
    push('info', `代理 ${vm.proxy?.host || 'bound'}`)
  }

  let model = String(opts.model || '').trim()
  if (!model) {
    const models = listTestableModels()
    model = models[0]?.id || 'claude-haiku-4-5-20251001'
  }
  push('info', `模型 ${model}`)

  const validated = validateOfficialModel(model)
  if (validated?.error) {
    push('error', `模型不可用: ${validated.error.message || validated.error}`)
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: validated.error || { code: 'model_not_allowed', message: 'model not allowed' },
      log,
      duration_ms: Date.now() - started,
    })
  }
  if (!isModelEnabled(model)) {
    push('error', '模型在策略中已禁用')
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: { code: 'model_disabled', message: 'model disabled by policy' },
      log,
      duration_ms: Date.now() - started,
    })
  }

  const prompt = String(opts.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT
  const params = getModelParams(model) || {}
  const caps = getCapabilities(model) || {}
  let maxTokens = Number(opts.max_tokens)
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    maxTokens = Number(params.max_tokens_default) || DEFAULT_MAX_TOKENS
  }
  maxTokens = Math.min(Math.max(1, Math.floor(maxTokens)), Number(params.max_tokens_cap) || 128000)

  push('info', `prompt=${JSON.stringify(prompt).slice(0, 120)} max_tokens=${maxTokens} thinking=${caps.requires_adaptive ? 'adaptive' : 'off'}`)

  const exec = buildExec(projectRoot, vm)
  const identity = loadVmIdentity(exec)
  let body
  try {
    body = prepareTestBody(model, prompt, maxTokens)
    body = officialMessagesBody(body, { stream: true })
    body = applyCrsIdentityReplace(body, identity, {})
    const prepared = prepareAnthropicRequest(body, { cacheControlLimit: 4, unofficial: true })
    body = prepared?.body || prepared || body
    body.stream = true
  } catch (e) {
    push('error', `请求准备失败: ${e.message || e}`)
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: { code: 'prepare_failed', message: String(e.message || e) },
      log,
      duration_ms: Date.now() - started,
    })
  }

  // Unofficial UA: skip storeAccountHeaders. Omit anthropic-beta so stored
  // Claude Code betas replay (same as RikkaHub / Go-http-client /v1).
  const reqHeaders = {
    'user-agent': TEST_UA,
    'anthropic-version': '2023-06-01',
  }
  const outboundHeaders = resolveCrsHeaders(reqHeaders, exec.homeDir, identity, model) || {}
  push('info', `出站 ua=${outboundHeaders['user-agent'] || '—'} beta=${outboundHeaders['anthropic-beta'] || '(none)'}`)
  push('info', `persona=${body.system ? 'claude-code' : 'none'} thinking=${body.thinking?.type || 'none'}`)
  push('info', '调用 Go slot worker /internal/v1/messages (upstream stream, assemble JSON) …')

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 90000, 10000), 180000)
  let result
  try {
    const assembler = createClaudeMessageAssembler()
    result = await streamGoWorker({
      exec,
      body,
      reqHeaders,
      timeoutMs,
      identity,
      deliveryMode: 'verified',
      onEvent: async (line) => {
        applyClaudeSSELineToMessage(line, assembler)
      },
    })
    if (assembler.message) {
      result.body = assembler.message
      if (assembler.message.usage) result.usage = assembler.message.usage
      if (assembler.message.model) result.model = assembler.message.model
      if (assembler.message.stop_reason) result.stopReason = assembler.message.stop_reason
    }
  } catch (e) {
    push('error', `worker 异常: ${e.message || e}`)
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: { code: 'worker_error', message: String(e.message || e).slice(0, 400) },
      log,
      duration_ms: Date.now() - started,
    })
  }

  const duration = Date.now() - started
  const text = extractText(result?.body)
  const usage = result?.usage || result?.body?.usage || null

  if (result?.ok) {
    push('ok', `成功 status=${result.status} stop=${result.stopReason || result.body?.stop_reason || '—'} ${duration}ms`)
    if (text) push('content', text.slice(0, 2000))
    if (usage) {
      push('info', `usage in=${usage.input_tokens ?? '—'} out=${usage.output_tokens ?? '—'} cache_read=${usage.cache_read_input_tokens ?? 0}`)
    }
  } else {
    const errObj = extractError(result)
    push('error', `失败 status=${result?.status || 0}: ${errObj.message}`)
    if (errObj.request_id) push('info', `request_id=${errObj.request_id}`)
  }

  return done({
    ok: !!result?.ok,
    vm_id: vmId,
    vm_name: vm.name || null,
    account_uuid: vm.claude?.account_uuid || vm.account_uuid || null,
    model,
    prompt,
    max_tokens: maxTokens,
    status: result?.status || 0,
    stop_reason: result?.stopReason || result?.body?.stop_reason || null,
    usage,
    text: text ? text.slice(0, 4000) : null,
    error: result?.ok ? null : extractError(result),
    duration_ms: duration,
    via: result?.via || 'go-worker',
    debug: {
      outbound_beta: outboundHeaders['anthropic-beta'] || null,
      outbound_ua: outboundHeaders['user-agent'] || null,
      thinking: body?.thinking?.type || null,
      persona: !!body?.system,
      upstream_model: result?.model || result?.body?.model || null,
    },
    log,
  })
}
