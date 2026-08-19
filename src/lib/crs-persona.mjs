/**
 * Third-party persona: append the official Claude Code one-liner.
 * Official Claude Code inbound is left untouched.
 */
export const CRS_OFFICIAL_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

export function systemToText(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n')
  }
  return system.text || ''
}

export function hasOfficialClaudeLine(system) {
  return systemToText(system).includes(CRS_OFFICIAL_SYSTEM)
}

export function applyCrsUnofficialPersona(body, { officialClient = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (officialClient) return body
  if (hasOfficialClaudeLine(body.system)) return body

  const existing = body.system
  if (!existing) return { ...body, system: CRS_OFFICIAL_SYSTEM }
  if (typeof existing === 'string') {
    return { ...body, system: `${existing.replace(/\s+$/, '')}\n\n${CRS_OFFICIAL_SYSTEM}` }
  }
  if (Array.isArray(existing)) {
    return { ...body, system: [...existing, { type: 'text', text: CRS_OFFICIAL_SYSTEM }] }
  }
  return { ...body, system: CRS_OFFICIAL_SYSTEM }
}
