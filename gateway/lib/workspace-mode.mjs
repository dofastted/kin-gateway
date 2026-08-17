/**
 * Workspace ownership.
 *
 * client (default): tools / files / shell run on the caller's machine
 *   (Windows Claude Code, IDE, Hermes, …). Gateway is protocol + identity.
 * vm (opt-in): tools run inside the VM cli-home. Header: x-kin-workspace: vm
 */
export function resolveWorkspaceMode(req = {}, inbound = {}, clientClass = '') {
  const raw = String(
    req.headers?.['x-kin-workspace'] ||
    req.headers?.['x-kin-tool-exec'] ||
    inbound?.workspace ||
    '',
  ).trim().toLowerCase()
  if (raw === 'vm' || raw === 'server' || raw === 'slot') return 'vm'
  if (raw === 'client' || raw === 'local' || raw === 'host') return 'client'
  return 'client'
}

export function isOfficialClaudeClient(clientClass) {
  return clientClass === 'claude_code_official' || clientClass === 'claude_official_cli'
}

export function requestNeedsClientTools(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (body.tool_choice) return true
  const msgs = body.messages || []
  for (const m of msgs) {
    if (m?.role === 'tool') return true
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length) return true
    const c = m?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use' || b?.type === 'tool_result') return true
      }
    }
  }
  return false
}

export function workspaceCapabilities() {
  return {
    default: 'client',
    tool_execution: 'client',
    vm_tools: 'opt-in',
    header: 'x-kin-workspace: client | vm',
  }
}
