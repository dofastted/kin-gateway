/**
 * Structured error taxonomy for KIN gateway.
 * Every error response:
 * {
 *   error: {
 *     type: string,      // high-level category
 *     code: string,      // machine-readable code
 *     message: string,   // human-readable
 *     param?: string,    // which field failed
 *     details?: object,  // optional context
 *     request_id?: string
 *   }
 * }
 */

export const ErrorType = {
  AUTH: 'authentication_error',
  PERMISSION: 'permission_error',
  INVALID_REQUEST: 'invalid_request_error',
  NOT_FOUND: 'not_found_error',
  RATE_LIMIT: 'rate_limit_error',
  QUOTA: 'quota_error',
  UPSTREAM: 'upstream_error',
  API: 'api_error',
  OVERLOADED: 'overloaded_error',
  TIMEOUT: 'timeout_error',
  PROTOCOL: 'protocol_error',
}

export const ErrorCode = {
  // auth
  INVALID_API_KEY: 'invalid_api_key',
  MISSING_API_KEY: 'missing_api_key',
  // body
  INVALID_JSON: 'invalid_json',
  BODY_TOO_LARGE: 'body_too_large',
  EMPTY_BODY: 'empty_body',
  MISSING_FIELD: 'missing_field',
  INVALID_FIELD: 'invalid_field',
  INVALID_MESSAGES: 'invalid_messages',
  INVALID_CONTENT: 'invalid_content',
  // model
  MODEL_REQUIRED: 'model_required',
  MODEL_NOT_SUPPORTED: 'model_not_supported',
  // quota / rate
  GATEWAY_RATE_LIMIT: 'gateway_rate_limit',
  QUOTA_5H_SAFETY: 'quota_5h_safety',
  QUOTA_7D_SAFETY: 'quota_7d_safety',
  CONCURRENCY_LIMIT: 'concurrency_limit',
  API_KEY_DISABLED: 'api_key_disabled',
  API_KEY_EXPIRED: 'api_key_expired',
  API_KEY_QUOTA_EXHAUSTED: 'api_key_quota_exhausted',
  API_KEY_RATE_LIMIT: 'api_key_rate_limit',
  API_KEY_CONCURRENCY_LIMIT: 'api_key_concurrency_limit',
  // upstream
  UPSTREAM_AUTH: 'upstream_auth_error',
  UPSTREAM_RATE_LIMIT: 'upstream_rate_limit',
  UPSTREAM_INVALID: 'upstream_invalid_request',
  UPSTREAM_OVERLOADED: 'upstream_overloaded',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ERROR: 'upstream_error',
  // protocol
  PROTOCOL_UNSUPPORTED: 'protocol_unsupported',
  CONVERT_FAILED: 'convert_failed',
  // resource
  VM_NOT_FOUND: 'vm_not_found',
  NOT_FOUND: 'not_found',
  OAUTH_NEED_REIMPORT: 'oauth_need_reimport',
  OAUTH_REFRESH_FAILED: 'oauth_refresh_failed',
}

export function makeError({
  type = ErrorType.API,
  code = 'unknown_error',
  message,
  param,
  details,
  status = 500,
  request_id,
}) {
  const error = { type, code, message: message || code }
  if (param) error.param = param
  if (details && Object.keys(details).length) error.details = details
  if (request_id) error.request_id = request_id
  return { status, body: { error } }
}

const GATEWAY_OVERLOAD_CODES = new Set(['server_overloaded', 'account_pool_exhausted'])
const CLIENT_CANCEL_CODES = new Set([
  'client_cancelled',
  'request_cancelled',
  'client_aborted',
  'selection_cancelled',
  'ECONNRESET',
  'aborted',
])

export function isClientCancelledCode(code, message = '') {
  const hay = `${code || ''} ${message || ''}`
  if (CLIENT_CANCEL_CODES.has(String(code || '').trim())) return true
  return /econnreset|client_aborted|request_cancelled|selection_cancelled|context canceled/i.test(hay)
}

export function isClientCancelledResult(result = {}) {
  const code = result?.body?.error?.code || result?.error_code || ''
  const message = result?.body?.error?.message || result?.error_message || ''
  return isClientCancelledCode(code, message)
}

/** Classify & map Anthropic upstream error body + HTTP status */
export function mapUpstreamError(status, body, headers = {}) {
  const upType = body?.error?.type || body?.type || null
  const inboundCode = body?.error?.code || null
  let msg =
    body?.error?.message ||
    body?.message ||
    (typeof body?.error === 'string' ? body.error : null) ||
    body?.raw ||
    null

  if (GATEWAY_OVERLOAD_CODES.has(String(inboundCode || ''))) {
    return makeError({
      type: ErrorType.OVERLOADED,
      code: inboundCode,
      message: String(msg || '服务器负载过高稍后重试'),
      status: 503,
      details: { upstream_type: upType, upstream_status: status },
    })
  }
  if (isClientCancelledCode(inboundCode, msg)) {
    return makeError({
      type: ErrorType.TIMEOUT,
      code: 'client_cancelled',
      message: String(msg || 'Client closed the connection'),
      status: 499,
      details: { upstream_status: status },
    })
  }

  // Anthropic sometimes returns literal "Error" — enrich for clients like RikkaHub
  if (!msg || String(msg).trim() === '' || /^error$/i.test(String(msg).trim())) {
    if (status === 429 || upType === 'rate_limit_error') {
      msg = 'Rate limit exceeded (upstream). Please retry later or switch account.'
    } else if (status === 401 || status === 403 || upType === 'authentication_error') {
      msg = 'Upstream authentication failed. OAuth credential may be expired.'
    } else if (status === 529 || upType === 'overloaded_error') {
      msg = 'Upstream overloaded. Please retry shortly.'
    } else if (upType) {
      msg = `Upstream error: ${upType} (HTTP ${status})`
    } else {
      msg = `Upstream HTTP ${status}`
    }
  }
  const request_id =
    body?.error?.request_id ||
    body?.request_id ||
    headers['request-id'] ||
    headers['x-request-id'] ||
    null

  if (status === 401 || status === 403 || upType === 'authentication_error') {
    return makeError({
      type: ErrorType.UPSTREAM,
      code: ErrorCode.UPSTREAM_AUTH,
      message: String(msg),
      status: status === 403 ? 403 : 401,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 429 || upType === 'rate_limit_error') {
    return makeError({
      type: ErrorType.RATE_LIMIT,
      code: ErrorCode.UPSTREAM_RATE_LIMIT,
      message: String(msg),
      status: 429,
      details: {
        upstream_type: upType,
        upstream_status: status,
        retry_after: headers['retry-after'] || null,
      },
      request_id,
    })
  }

  if (status === 529 || upType === 'overloaded_error') {
    return makeError({
      type: ErrorType.OVERLOADED,
      code: ErrorCode.UPSTREAM_OVERLOADED,
      message: String(msg),
      status: 529,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 400 || upType === 'invalid_request_error') {
    return makeError({
      type: ErrorType.INVALID_REQUEST,
      code: ErrorCode.UPSTREAM_INVALID,
      message: String(msg),
      status: 400,
      param: body?.error?.param || undefined,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 408 || (/timeout/i.test(String(msg)) && !/aborted|econnreset|cancel/i.test(String(msg)))) {
    return makeError({
      type: ErrorType.TIMEOUT,
      code: ErrorCode.UPSTREAM_TIMEOUT,
      message: String(msg),
      status: 504,
      details: { upstream_status: status },
      request_id,
    })
  }

  return makeError({
    type: ErrorType.UPSTREAM,
    code: ErrorCode.UPSTREAM_ERROR,
    message: String(msg),
    status: status >= 400 && status < 600 ? status : 502,
    details: { upstream_type: upType, upstream_status: status },
    request_id,
  })
}

/**
 * Validate protocol request body before convert/upstream.
 * @returns {{ ok: true, body } | { ok: false, errorResult }}
 */
export function validateRequestBody(protocol, body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      errorResult: makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.EMPTY_BODY,
        message: 'Request body must be a JSON object',
        status: 400,
      }),
    }
  }

  // model
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
    return {
      ok: false,
      errorResult: makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.MODEL_REQUIRED,
        message: 'model is required and must be a non-empty string',
        param: 'model',
        status: 400,
      }),
    }
  }

  if (protocol === 'openai.chat' || protocol === 'anthropic.messages') {
    if (!Array.isArray(body.messages)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_MESSAGES,
          message: 'messages must be an array',
          param: 'messages',
          status: 400,
        }),
      }
    }
    if (body.messages.length === 0) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_MESSAGES,
          message: 'messages must contain at least one item',
          param: 'messages',
          status: 400,
        }),
      }
    }
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i]
      if (!m || typeof m !== 'object') {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.INVALID_MESSAGES,
            message: `messages[${i}] must be an object`,
            param: `messages[${i}]`,
            status: 400,
          }),
        }
      }
      if (!m.role || typeof m.role !== 'string') {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.MISSING_FIELD,
            message: `messages[${i}].role is required`,
            param: `messages[${i}].role`,
            status: 400,
          }),
        }
      }
      if (m.content == null && !m.tool_calls) {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.MISSING_FIELD,
            message: `messages[${i}].content is required (unless tool_calls present)`,
            param: `messages[${i}].content`,
            status: 400,
          }),
        }
      }
    }
  }

  if (protocol === 'openai.completions') {
    const prompt = body.prompt
    const ok = typeof prompt === 'string'
      ? prompt.length > 0
      : Array.isArray(prompt) && prompt.length > 0
    if (!ok) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.MISSING_FIELD,
          message: 'prompt is required for Completions API',
          param: 'prompt',
          status: 400,
        }),
      }
    }
  }

  if (protocol === 'openai.responses') {
    // input can be string or array; or messages
    if (body.input == null && !Array.isArray(body.messages)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.MISSING_FIELD,
          message: 'input (or messages) is required for Responses API',
          param: 'input',
          status: 400,
        }),
      }
    }
  }

  if (protocol === 'anthropic.messages') {
    if (body.max_tokens != null && (typeof body.max_tokens !== 'number' || body.max_tokens < 1)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_FIELD,
          message: 'max_tokens must be a positive number',
          param: 'max_tokens',
          status: 400,
        }),
      }
    }
  }

  return { ok: true, body }
}

/** Inspect body for error diagnostics (safe summary, no secrets) */
export function inspectRequestBody(body) {
  if (body == null) return { empty: true }
  if (typeof body !== 'object') return { type: typeof body }
  return {
    keys: Object.keys(body).sort(),
    model: body.model ?? null,
    stream: !!body.stream,
    messages_count: Array.isArray(body.messages) ? body.messages.length : null,
    has_input: body.input != null,
    has_tools: Array.isArray(body.tools) && body.tools.length > 0,
    has_system: body.system != null || (Array.isArray(body.messages) && body.messages.some((m) => m?.role === 'system')),
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? null,
  }
}

export function mapQuotaGateError(gate) {
  const code = gate.reason || 'quota_error'
  const type =
    code === 'concurrency_limit' ? ErrorType.RATE_LIMIT : ErrorType.QUOTA
  return makeError({
    type,
    code,
    message: gate.detail?.message || gate.reason || 'Quota exceeded',
    status: 429,
    details: gate.detail || undefined,
  })
}

export function mapModelError(modelCheck) {
  const e = modelCheck.error || {}
  return makeError({
    type: e.type || ErrorType.INVALID_REQUEST,
    code: e.code || ErrorCode.MODEL_NOT_SUPPORTED,
    message: e.message || 'Model not supported',
    param: e.param || 'model',
    status: 400,
  })
}
