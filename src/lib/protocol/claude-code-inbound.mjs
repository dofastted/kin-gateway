/**
 * Official Claude Code inbound for probe-class traffic.
 * Mimics real CLI body + stainless headers. Omits anthropic-beta so stored
 * Claude Code betas replay and kin-cc-headers.json is not overwritten.
 */
import { CRS_OFFICIAL_SYSTEM, DEFAULT_CLI_VERSION } from '../identity/crs-persona.mjs'
import { formatMetadataUserId } from '../identity/vm-identity.mjs'

export const CLAUDE_CLI_UA = `claude-cli/${DEFAULT_CLI_VERSION} (external, cli)`
export const LOADTEST_UA = 'kin-console-loadtest/1.0'

export function claudeCodeInboundHeaders({ sessionId, accept = 'text/event-stream' } = {}) {
  const headers = {
    'user-agent': CLAUDE_CLI_UA,
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-package-version': '0.112.1',
    'x-stainless-runtime-version': 'v24.3.0',
    accept,
  }
  if (sessionId) headers['x-claude-code-session-id'] = sessionId
  return headers
}

export function claudeCodeProbeUserId(sessionId) {
  return formatMetadataUserId({
    deviceId: 'probe',
    accountUuid: '',
    sessionId: sessionId || '00000000-0000-4000-8000-000000000001',
  })
}

export function claudeCodeInboundBody({
  model,
  messages,
  maxTokens,
  thinking = null,
  sessionId,
  temperature = 1,
  stream = true,
} = {}) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: !!stream,
    temperature,
    system: CRS_OFFICIAL_SYSTEM,
    metadata: { user_id: claudeCodeProbeUserId(sessionId) },
    messages: Array.isArray(messages) ? messages : [],
  }
  if (thinking) body.thinking = thinking
  return body
}

export function isLoadtestUa(ua = '') {
  return /^kin-console-(loadtest|test)\//i.test(String(ua || ''))
}
