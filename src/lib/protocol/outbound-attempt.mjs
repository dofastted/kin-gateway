/**
 * Single outbound assembly used by /v1 applyAttempt and probe-class helpers.
 * Tests compare envelopes from this module so admin paths cannot drift.
 */
import { officialMessagesBody } from './anthropic-messages.mjs'
import { prepareAnthropicRequest, rewriteToolNames } from './anthropic-policy.mjs'
import { applyCrsIdentityReplace } from '../identity/identity-rewrite.mjs'
import { resolveCrsHeaders } from '../identity/crs-headers.mjs'

export function prepareOutboundAttempt({
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
} = {}) {
  const identified = applyCrsIdentityReplace(
    officialMessagesBody(canonicalBody, { stream }),
    identity,
    inbound,
  )
  const cleaned = prepareAnthropicRequest(identified, {
    cacheControlLimit,
    unofficial: !!unofficial,
  })
  const tools = rewriteToolNames(cleaned, { enabled: toolNameRewrite !== false })
  return { body: tools.body, toolNames: tools.reverse }
}

export function prepareOutboundHeaders(reqHeaders, homeDir, identity, model) {
  return resolveCrsHeaders(reqHeaders, homeDir, identity, model)
}
