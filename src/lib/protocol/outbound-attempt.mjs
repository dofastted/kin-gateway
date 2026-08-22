/**
 * Single outbound assembly used by /v1 applyAttempt and probe-class helpers.
 * Tests compare envelopes from this module so admin paths cannot drift.
 */
import { officialMessagesBody } from './anthropic-messages.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  sanitizeAnthropicBodyForBetaTokens,
} from './anthropic-policy.mjs'
import { applyCrsIdentityReplace } from '../identity/identity-rewrite.mjs'
import { resolveCrsHeaders } from '../identity/crs-headers.mjs'
import { applyCacheTtlToBody } from './cache-ttl.mjs'

export function prepareOutboundAttempt({
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
} = {}) {
  const identified = applyCrsIdentityReplace(
    officialMessagesBody(canonicalBody, { stream }),
    identity,
    inbound,
  )
  let cleaned = prepareAnthropicRequest(identified, {
    cacheControlLimit,
    unofficial: !!unofficial,
  })
  if (cacheTtl) cleaned = applyCacheTtlToBody(cleaned, cacheTtl)
  const tools = rewriteToolNames(cleaned, { enabled: toolNameRewrite !== false })
  return { body: tools.body, toolNames: tools.reverse }
}

export function prepareOutboundHeaders(reqHeaders, homeDir, identity, model) {
  return resolveCrsHeaders(reqHeaders, homeDir, identity, model)
}

/** Body + headers after the context_management ↔ context-management beta gate. */
export function prepareOutboundEnvelope({
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
  reqHeaders = {},
  homeDir = '',
} = {}) {
  const prepared = prepareOutboundAttempt({
    canonicalBody,
    inbound,
    identity,
    unofficial,
    stream,
    cacheControlLimit,
    toolNameRewrite,
    cacheTtl,
  })
  const headers = prepareOutboundHeaders(
    reqHeaders,
    homeDir,
    identity,
    prepared.body?.model || inbound?.model || canonicalBody?.model,
  )
  const body = sanitizeAnthropicBodyForBetaTokens(prepared.body, headers?.['anthropic-beta'] || '')
  return { body, headers, toolNames: prepared.toolNames }
}
